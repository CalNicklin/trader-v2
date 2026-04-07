import { desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import {
	agentLogs,
	livePositions,
	liveTrades,
	newsEvents,
	paperTrades,
	quotesCache,
	riskState,
	strategies,
	strategyMetrics,
	tradeInsights,
} from "../db/schema.ts";
import {
	DAILY_LOSS_HALT_PCT,
	MAX_CONCURRENT_POSITIONS,
	MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT,
	WEEKLY_DRAWDOWN_LIMIT_PCT,
} from "../risk/constants.ts";
import { getDailySpend } from "../utils/budget.ts";
import { getNextCronOccurrences } from "./cron-schedule.ts";
import { isPaused } from "./health.ts";

export interface NewsPipelineData {
	totalArticles24h: number;
	classifiedCount: number;
	tradeableHighUrgency: number;
	avgSentiment: number;
	recentArticles: Array<{
		time: string;
		symbols: string[];
		headline: string;
		sentiment: number | null;
		confidence: number | null;
		urgency: string | null;
		eventType: string | null;
		tradeable: boolean | null;
	}>;
}

export interface DashboardData {
	status: "ok" | "degraded" | "error";
	uptime: number;
	timestamp: string;
	paused: boolean;
	ibkrConnected: boolean;
	ibkrAccount: string | null;

	dailyPnl: number;
	weeklyPnl: number;
	dailyPnlLimit: number;
	weeklyPnlLimit: number;
	openPositionCount: number;
	maxPositions: number;
	tradesToday: number;
	apiSpendToday: number;
	apiBudget: number;
	lastQuoteTime: string | null;

	strategies: Array<{
		id: number;
		name: string;
		status: string;
		winRate: number | null;
		sharpeRatio: number | null;
		tradeCount: number;
		universe: string[];
	}>;

	positions: Array<{
		symbol: string;
		exchange: string;
		quantity: number;
		avgCost: number;
		unrealizedPnl: number | null;
		strategyId: number | null;
	}>;

	cronJobs: Array<{
		name: string;
		nextRun: string;
		nextRunIn: string;
		lastStatus: "ok" | "error" | "never";
	}>;

	recentLogs: Array<{
		time: string;
		level: string;
		phase: string | null;
		message: string;
	}>;

	gitHash: string;
}

/** Cached at boot — doesn't change during runtime. */
let _gitHash: string | null = null;

function getGitHash(): string {
	if (_gitHash) return _gitHash;
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
		_gitHash = result.stdout.toString().trim() || "unknown";
	} catch {
		_gitHash = "unknown";
	}
	return _gitHash;
}

/** Cached IBKR account ID — fetched once. */
let _ibkrAccount: string | null = null;
let _ibkrAccountFetched = false;

async function getIbkrAccount(): Promise<string | null> {
	if (_ibkrAccountFetched) return _ibkrAccount;
	try {
		const { getConfig } = await import("../config.ts");
		if (!getConfig().LIVE_TRADING_ENABLED) {
			_ibkrAccountFetched = true;
			return null;
		}
		const { getAccountSummary } = await import("../broker/account.ts");
		const summary = await getAccountSummary();
		_ibkrAccount = summary.accountId;
	} catch {
		_ibkrAccount = null;
	}
	_ibkrAccountFetched = true;
	return _ibkrAccount;
}

export async function getDashboardData(): Promise<DashboardData> {
	const db = getDb();

	// IBKR connection — only import broker module if live trading is on
	let ibkrConnected = false;
	try {
		const { getConfig } = await import("../config.ts");
		if (getConfig().LIVE_TRADING_ENABLED) {
			const { isConnected } = await import("../broker/connection.ts");
			ibkrConnected = isConnected();
		}
	} catch {
		// Broker module not loaded
	}

	// P&L from risk_state
	const dailyRow = db.select().from(riskState).where(eq(riskState.key, "daily_pnl")).get();
	const weeklyRow = db.select().from(riskState).where(eq(riskState.key, "weekly_pnl")).get();
	const dailyPnl = dailyRow ? Number.parseFloat(dailyRow.value) || 0 : 0;
	const weeklyPnl = weeklyRow ? Number.parseFloat(weeklyRow.value) || 0 : 0;

	// Positions
	const positions = db.select().from(livePositions).all();

	// Trades today
	const today = new Date().toISOString().split("T")[0]!;
	const tradesTodayResult = db
		.select({ count: sql<number>`count(*)` })
		.from(liveTrades)
		.where(sql`date(${liveTrades.createdAt}) = ${today}`)
		.get();
	const tradesToday = tradesTodayResult?.count ?? 0;

	// API spend
	const apiSpendToday = await getDailySpend(db);
	let apiBudget = 0;
	try {
		const { getConfig } = await import("../config.ts");
		apiBudget = getConfig().DAILY_API_BUDGET_USD;
	} catch {
		// Config not available
	}

	// Last quote
	const lastQuote = db
		.select({ updatedAt: quotesCache.updatedAt })
		.from(quotesCache)
		.orderBy(desc(quotesCache.updatedAt))
		.limit(1)
		.get();

	// Strategies with metrics
	const allStrategies = db
		.select({
			id: strategies.id,
			name: strategies.name,
			status: strategies.status,
			universe: strategies.universe,
			winRate: strategyMetrics.winRate,
			sharpeRatio: strategyMetrics.sharpeRatio,
		})
		.from(strategies)
		.leftJoin(strategyMetrics, eq(strategies.id, strategyMetrics.strategyId))
		.where(ne(strategies.status, "retired"))
		.all();

	// Trade counts per strategy
	const tradeCounts = db
		.select({
			strategyId: paperTrades.strategyId,
			count: sql<number>`count(*)`,
		})
		.from(paperTrades)
		.groupBy(paperTrades.strategyId)
		.all();
	const tradeCountMap = new Map(tradeCounts.map((t) => [t.strategyId, t.count]));

	const tierOrder: Record<string, number> = {
		core: 0,
		active: 1,
		probation: 2,
		paper: 3,
	};
	const strategyData = allStrategies
		.map((s) => ({
			id: s.id,
			name: s.name,
			status: s.status,
			winRate: s.winRate,
			sharpeRatio: s.sharpeRatio,
			tradeCount: tradeCountMap.get(s.id) ?? 0,
			universe: JSON.parse(s.universe ?? "[]") as string[],
		}))
		.sort((a, b) => (tierOrder[a.status] ?? 99) - (tierOrder[b.status] ?? 99));

	// Cron schedule with last run status
	const cronOccurrences = getNextCronOccurrences();
	const cronJobs = cronOccurrences.map((occ) => {
		const lastLog = db
			.select({ level: agentLogs.level })
			.from(agentLogs)
			.where(eq(agentLogs.phase, occ.name))
			.orderBy(desc(agentLogs.createdAt))
			.limit(1)
			.get();

		let lastStatus: "ok" | "error" | "never" = "never";
		if (lastLog) {
			lastStatus = lastLog.level === "ERROR" ? "error" : "ok";
		}

		return { ...occ, lastStatus };
	});

	// Recent logs
	const logs = db
		.select({
			createdAt: agentLogs.createdAt,
			level: agentLogs.level,
			phase: agentLogs.phase,
			message: agentLogs.message,
		})
		.from(agentLogs)
		.orderBy(desc(agentLogs.createdAt))
		.limit(20)
		.all();

	const recentLogs = logs.map((l) => ({
		time: new Date(l.createdAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "UTC",
		}),
		level: l.level,
		phase: l.phase,
		message: l.message,
	}));

	// Status determination
	let status: "ok" | "degraded" | "error" = "ok";
	if (isPaused()) {
		status = "degraded";
	} else if (lastQuote?.updatedAt) {
		const lastQuoteAge = Date.now() - new Date(lastQuote.updatedAt).getTime();
		const hour = new Date().getUTCHours();
		if (lastQuoteAge > 3_600_000 && hour >= 8 && hour <= 21) {
			status = "degraded";
		}
	}

	const ibkrAccount = await getIbkrAccount();

	return {
		status,
		uptime: process.uptime(),
		timestamp: new Date().toISOString(),
		paused: isPaused(),
		ibkrConnected,
		ibkrAccount: ibkrConnected ? ibkrAccount : null,
		dailyPnl,
		weeklyPnl,
		dailyPnlLimit: DAILY_LOSS_HALT_PCT * 100,
		weeklyPnlLimit: WEEKLY_DRAWDOWN_LIMIT_PCT * 100,
		openPositionCount: positions.length,
		maxPositions: MAX_CONCURRENT_POSITIONS,
		tradesToday,
		apiSpendToday,
		apiBudget,
		lastQuoteTime: lastQuote?.updatedAt ?? null,
		strategies: strategyData,
		positions: positions.map((p) => ({
			symbol: p.symbol,
			exchange: p.exchange,
			quantity: p.quantity,
			avgCost: p.avgCost,
			unrealizedPnl: p.unrealizedPnl,
			strategyId: p.strategyId,
		})),
		cronJobs,
		recentLogs,
		gitHash: getGitHash(),
	};
}

export async function getNewsPipelineData(): Promise<NewsPipelineData> {
	const db = getDb();
	const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const totalResult = db
		.select({ count: sql<number>`count(*)` })
		.from(newsEvents)
		.where(sql`${newsEvents.createdAt} >= ${since24h}`)
		.get();
	const totalArticles24h = totalResult?.count ?? 0;

	const classifiedResult = db
		.select({ count: sql<number>`count(*)` })
		.from(newsEvents)
		.where(sql`${newsEvents.createdAt} >= ${since24h} AND ${newsEvents.sentiment} IS NOT NULL`)
		.get();
	const classifiedCount = classifiedResult?.count ?? 0;

	const tradeableResult = db
		.select({ count: sql<number>`count(*)` })
		.from(newsEvents)
		.where(
			sql`${newsEvents.createdAt} >= ${since24h} AND ${newsEvents.tradeable} = 1 AND ${newsEvents.urgency} = 'high'`,
		)
		.get();
	const tradeableHighUrgency = tradeableResult?.count ?? 0;

	const avgResult = db
		.select({ avg: sql<number | null>`avg(${newsEvents.sentiment})` })
		.from(newsEvents)
		.where(sql`${newsEvents.createdAt} >= ${since24h} AND ${newsEvents.sentiment} IS NOT NULL`)
		.get();
	const avgSentiment = avgResult?.avg ?? 0;

	const rows = db
		.select({
			createdAt: newsEvents.createdAt,
			symbols: newsEvents.symbols,
			headline: newsEvents.headline,
			sentiment: newsEvents.sentiment,
			confidence: newsEvents.confidence,
			urgency: newsEvents.urgency,
			eventType: newsEvents.eventType,
			tradeable: newsEvents.tradeable,
		})
		.from(newsEvents)
		.orderBy(desc(newsEvents.createdAt))
		.limit(50)
		.all();

	const recentArticles = rows.map((r) => ({
		time: new Date(r.createdAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "UTC",
		}),
		symbols: r.symbols ? (JSON.parse(r.symbols) as string[]) : [],
		headline: r.headline,
		sentiment: r.sentiment,
		confidence: r.confidence,
		urgency: r.urgency ?? null,
		eventType: r.eventType ?? null,
		tradeable: r.tradeable ?? null,
	}));

	return {
		totalArticles24h,
		classifiedCount,
		tradeableHighUrgency,
		avgSentiment,
		recentArticles,
	};
}

export interface LearningLoopData {
	insightsCount7d: number;
	ledToImprovement: number;
	patternsFound: number;
	recentInsights: Array<{
		time: string;
		insightType: string;
		observation: string;
		suggestedAction: string | null;
		confidence: number | null;
		tags: string[];
		ledToImprovement: boolean | null;
	}>;
}

export async function getLearningLoopData(): Promise<LearningLoopData> {
	const db = getDb();
	const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

	const totalResult = db
		.select({ count: sql<number>`count(*)` })
		.from(tradeInsights)
		.where(sql`${tradeInsights.createdAt} >= ${cutoff}`)
		.get();
	const insightsCount7d = totalResult?.count ?? 0;

	const improvementResult = db
		.select({ count: sql<number>`count(*)` })
		.from(tradeInsights)
		.where(sql`${tradeInsights.createdAt} >= ${cutoff} AND ${tradeInsights.ledToImprovement} = 1`)
		.get();
	const ledToImprovement = improvementResult?.count ?? 0;

	const patternsResult = db
		.select({ count: sql<number>`count(*)` })
		.from(tradeInsights)
		.where(
			sql`${tradeInsights.createdAt} >= ${cutoff} AND ${tradeInsights.insightType} = 'pattern_analysis'`,
		)
		.get();
	const patternsFound = patternsResult?.count ?? 0;

	const rows = db
		.select({
			createdAt: tradeInsights.createdAt,
			insightType: tradeInsights.insightType,
			observation: tradeInsights.observation,
			suggestedAction: tradeInsights.suggestedAction,
			confidence: tradeInsights.confidence,
			tags: tradeInsights.tags,
			ledToImprovement: tradeInsights.ledToImprovement,
		})
		.from(tradeInsights)
		.orderBy(desc(tradeInsights.createdAt))
		.limit(30)
		.all();

	const recentInsights = rows.map((r) => ({
		time: new Date(r.createdAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "UTC",
		}),
		insightType: r.insightType,
		observation: r.observation,
		suggestedAction: r.suggestedAction ?? null,
		confidence: r.confidence ?? null,
		tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
		ledToImprovement: r.ledToImprovement ?? null,
	}));

	return {
		insightsCount7d,
		ledToImprovement,
		patternsFound,
		recentInsights,
	};
}

export interface GuardianData {
	circuitBreaker: { active: boolean; drawdownPct: number; limitPct: number };
	dailyHalt: { active: boolean; lossPct: number; limitPct: number };
	weeklyDrawdown: { active: boolean; lossPct: number; limitPct: number };
	peakBalance: number;
	accountBalance: number;
	checkHistory: Array<{ time: string; level: string; message: string }>;
}

export async function getGuardianData(): Promise<GuardianData> {
	const db = getDb();

	const rows = db.select().from(riskState).all();
	const state = new Map(rows.map((r) => [r.key, r.value]));

	const circuitBreakerActive = state.get("circuit_breaker_tripped") === "true";
	const dailyHaltActive = state.get("daily_halt_active") === "true";
	const weeklyDrawdownActive = state.get("weekly_drawdown_active") === "true";

	const peakBalance = Number.parseFloat(state.get("peak_balance") ?? "0") || 0;
	const accountBalance = Number.parseFloat(state.get("account_balance") ?? "0") || 0;
	const dailyPnl = Number.parseFloat(state.get("daily_pnl") ?? "0") || 0;
	const weeklyPnl = Number.parseFloat(state.get("weekly_pnl") ?? "0") || 0;

	const drawdownPct =
		peakBalance > 0 ? Math.round(((peakBalance - accountBalance) / peakBalance) * 100 * 10) / 10 : 0;

	const dailyLossPct =
		accountBalance > 0
			? Math.round((Math.abs(Math.min(0, dailyPnl)) / accountBalance) * 100 * 10) / 10
			: 0;

	const weeklyLossPct =
		accountBalance > 0
			? Math.round((Math.abs(Math.min(0, weeklyPnl)) / accountBalance) * 100 * 10) / 10
			: 0;

	const logs = db
		.select({
			createdAt: agentLogs.createdAt,
			level: agentLogs.level,
			message: agentLogs.message,
		})
		.from(agentLogs)
		.where(eq(agentLogs.phase, "risk_guardian"))
		.orderBy(desc(agentLogs.createdAt))
		.limit(30)
		.all();

	const checkHistory = logs.map((l) => ({
		time: new Date(l.createdAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "UTC",
		}),
		level: l.level,
		message: l.message,
	}));

	return {
		circuitBreaker: {
			active: circuitBreakerActive,
			drawdownPct,
			limitPct: Math.round(MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT * 100 * 10) / 10,
		},
		dailyHalt: {
			active: dailyHaltActive,
			lossPct: dailyLossPct,
			limitPct: Math.round(DAILY_LOSS_HALT_PCT * 100 * 10) / 10,
		},
		weeklyDrawdown: {
			active: weeklyDrawdownActive,
			lossPct: weeklyLossPct,
			limitPct: Math.round(WEEKLY_DRAWDOWN_LIMIT_PCT * 100 * 10) / 10,
		},
		peakBalance,
		accountBalance,
		checkHistory,
	};
}
