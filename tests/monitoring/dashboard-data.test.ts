import { beforeEach, describe, expect, test } from "bun:test";
import {
	agentLogs,
	livePositions,
	liveTrades,
	newsEvents,
	paperTrades,
	riskState,
	strategies,
	strategyMetrics,
	tradeInsights,
} from "../../src/db/schema.ts";

async function setupDb() {
	const { resetConfigForTesting } = await import("../../src/config.ts");
	resetConfigForTesting();
	const { closeDb, getDb } = await import("../../src/db/client.ts");
	closeDb();
	const db = getDb();
	const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
	db.delete(riskState).run();
	db.delete(agentLogs).run();
	return db;
}

describe("getDashboardData", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		db.delete(strategies).run();
		db.delete(livePositions).run();
		db.delete(liveTrades).run();
		db.delete(agentLogs).run();
		db.delete(riskState).run();
		db.delete(strategyMetrics).run();
		db.delete(newsEvents).run();
		db.delete(paperTrades).run();
		db.delete(tradeInsights).run();
	});

	test("returns valid DashboardData shape with empty tables", async () => {
		const { getDashboardData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getDashboardData();

		expect(data.status).toBeDefined();
		expect(data.uptime).toBeGreaterThan(0);
		expect(data.timestamp).toBeDefined();
		expect(typeof data.paused).toBe("boolean");
		expect(typeof data.ibkrConnected).toBe("boolean");
		expect(Array.isArray(data.strategies)).toBe(true);
		expect(Array.isArray(data.positions)).toBe(true);
		expect(Array.isArray(data.cronJobs)).toBe(true);
		expect(Array.isArray(data.recentLogs)).toBe(true);
		expect(typeof data.gitHash).toBe("string");
	});

	test("includes strategies with metrics", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const { getDashboardData } = await import("../../src/monitoring/dashboard-data.ts");
		const db = getDb();
		const [s] = db
			.insert(strategies)
			.values({
				name: "test_strat",
				description: "desc",
				parameters: "{}",
				signals: '{"entry_long":"price>0"}',
				universe: '["AAPL","MSFT"]',
				status: "paper",
			})
			.returning()
			.all();

		db.insert(strategyMetrics)
			.values({
				strategyId: s!.id,
				sampleSize: 10,
				winRate: 0.55,
				sharpeRatio: 1.2,
			})
			.run();

		const data = await getDashboardData();
		expect(data.strategies.length).toBe(1);
		expect(data.strategies[0]!.name).toBe("test_strat");
		expect(data.strategies[0]!.winRate).toBe(0.55);
		expect(data.strategies[0]!.sharpeRatio).toBe(1.2);
		expect(data.strategies[0]!.universe).toEqual(["AAPL", "MSFT"]);
	});

	test("includes live positions", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const { getDashboardData } = await import("../../src/monitoring/dashboard-data.ts");
		const db = getDb();
		db.insert(livePositions)
			.values({
				symbol: "HSBA",
				exchange: "LSE",
				quantity: -3909,
				avgCost: 13.91,
			})
			.run();

		const data = await getDashboardData();
		expect(data.positions.length).toBe(1);
		expect(data.positions[0]!.symbol).toBe("HSBA");
		expect(data.positions[0]!.quantity).toBe(-3909);
	});

	test("counts trades today", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const { getDashboardData } = await import("../../src/monitoring/dashboard-data.ts");
		const db = getDb();
		db.insert(liveTrades)
			.values({
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "BUY",
				quantity: 10,
				orderType: "LIMIT",
				status: "FILLED",
			})
			.run();

		const data = await getDashboardData();
		expect(data.tradesToday).toBe(1);
	});

	test("reads PnL from risk_state", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const { getDashboardData } = await import("../../src/monitoring/dashboard-data.ts");
		const db = getDb();
		db.insert(riskState).values({ key: "daily_pnl", value: "42.5" }).run();
		db.insert(riskState).values({ key: "weekly_pnl", value: "-10.0" }).run();

		const data = await getDashboardData();
		expect(data.dailyPnl).toBe(42.5);
		expect(data.weeklyPnl).toBe(-10.0);
	});

	test("includes recent agent logs", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const { getDashboardData } = await import("../../src/monitoring/dashboard-data.ts");
		const db = getDb();
		db.insert(agentLogs)
			.values({
				level: "WARN",
				phase: "reconciliation",
				message: "Orphaned position found",
			})
			.run();

		const data = await getDashboardData();
		expect(data.recentLogs.length).toBe(1);
		expect(data.recentLogs[0]!.level).toBe("WARN");
		expect(data.recentLogs[0]!.message).toBe("Orphaned position found");
	});

	test("cronJobs has 17 entries sorted by nextRun", async () => {
		const { getDashboardData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getDashboardData();
		expect(data.cronJobs.length).toBe(17);
		for (let i = 1; i < data.cronJobs.length; i++) {
			expect(new Date(data.cronJobs[i]!.nextRun).getTime()).toBeGreaterThanOrEqual(
				new Date(data.cronJobs[i - 1]!.nextRun).getTime(),
			);
		}
	});
});

describe("getNewsPipelineData", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		db.delete(newsEvents).run();
		db.delete(paperTrades).run();
		db.delete(tradeInsights).run();
	});

	test("returns zeroed stats with empty table", async () => {
		const { getNewsPipelineData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getNewsPipelineData();

		expect(data.totalArticles24h).toBe(0);
		expect(data.classifiedCount).toBe(0);
		expect(data.tradeableHighUrgency).toBe(0);
		expect(data.avgSentiment).toBe(0);
		expect(Array.isArray(data.recentArticles)).toBe(true);
		expect(data.recentArticles.length).toBe(0);
	});

	test("returns correct stats with populated data", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const { getNewsPipelineData } = await import("../../src/monitoring/dashboard-data.ts");
		const db = getDb();

		// Article 1: classified, tradeable, high urgency
		db.insert(newsEvents)
			.values({
				source: "finnhub",
				headline: "AAPL beats earnings",
				symbols: '["AAPL"]',
				sentiment: 0.8,
				confidence: 0.9,
				tradeable: true,
				urgency: "high",
				eventType: "earnings",
			})
			.run();

		// Article 2: classified, not tradeable, low urgency
		db.insert(newsEvents)
			.values({
				source: "finnhub",
				headline: "MSFT minor update",
				symbols: '["MSFT"]',
				sentiment: 0.2,
				confidence: 0.7,
				tradeable: false,
				urgency: "low",
				eventType: "general",
			})
			.run();

		// Article 3: unclassified (no sentiment)
		db.insert(newsEvents)
			.values({
				source: "finnhub",
				headline: "Some unclassified news",
				symbols: '["TSLA"]',
			})
			.run();

		const data = await getNewsPipelineData();

		expect(data.totalArticles24h).toBe(3);
		expect(data.classifiedCount).toBe(2);
		expect(data.tradeableHighUrgency).toBe(1);
		// avg of 0.8 and 0.2 = 0.5
		expect(data.avgSentiment).toBeCloseTo(0.5, 5);
		expect(data.recentArticles.length).toBe(3);

		// Most recent article should be first
		const first = data.recentArticles[0]!;
		expect(typeof first.time).toBe("string");
		expect(Array.isArray(first.symbols)).toBe(true);
		expect(typeof first.headline).toBe("string");
	});
});

describe("getLearningLoopData", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		db.delete(tradeInsights).run();
	});

	test("returns zeroed stats and empty recentInsights with empty table", async () => {
		const { getLearningLoopData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getLearningLoopData();

		expect(data.insightsCount7d).toBe(0);
		expect(data.ledToImprovement).toBe(0);
		expect(data.patternsFound).toBe(0);
		expect(Array.isArray(data.recentInsights)).toBe(true);
		expect(data.recentInsights.length).toBe(0);
	});

	test("returns correct counts with populated data", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const { getLearningLoopData } = await import("../../src/monitoring/dashboard-data.ts");
		const db = getDb();

		// Insight 1: trade_review, led_to_improvement = true
		db.insert(tradeInsights)
			.values({
				strategyId: 1,
				insightType: "trade_review",
				tags: '["momentum","breakout"]',
				observation: "Strong uptrend observed",
				suggestedAction: null,
				confidence: 0.85,
				ledToImprovement: true,
			})
			.run();

		// Insight 2: pattern_analysis
		db.insert(tradeInsights)
			.values({
				strategyId: 1,
				insightType: "pattern_analysis",
				tags: '["pattern"]',
				observation: "Double bottom detected",
				suggestedAction: null,
				confidence: 0.7,
				ledToImprovement: null,
			})
			.run();

		// Insight 3: trade_review, led_to_improvement = null
		db.insert(tradeInsights)
			.values({
				strategyId: 2,
				insightType: "trade_review",
				tags: "[]",
				observation: "Sideways chop",
				suggestedAction: null,
				confidence: null,
				ledToImprovement: null,
			})
			.run();

		const data = await getLearningLoopData();

		expect(data.insightsCount7d).toBe(3);
		expect(data.ledToImprovement).toBe(1);
		expect(data.patternsFound).toBe(1);
		expect(data.recentInsights.length).toBe(3);

		const first = data.recentInsights[0]!;
		expect(typeof first.time).toBe("string");
		expect(typeof first.insightType).toBe("string");
		expect(typeof first.observation).toBe("string");
		expect(Array.isArray(first.tags)).toBe(true);
	});
});

describe("getGuardianData", () => {
	beforeEach(async () => {
		await setupDb();
	});

	test("returns inactive state with empty risk_state", async () => {
		const { getGuardianData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getGuardianData();

		expect(data.circuitBreaker.active).toBe(false);
		expect(data.dailyHalt.active).toBe(false);
		expect(data.weeklyDrawdown.active).toBe(false);
		expect(data.peakBalance).toBe(0);
		expect(data.accountBalance).toBe(0);
		expect(Array.isArray(data.checkHistory)).toBe(true);
		expect(data.checkHistory.length).toBe(0);
	});

	test("returns correct computed values with populated state", async () => {
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		db.delete(riskState).run();
		db.delete(agentLogs).run();

		// peak=10000, account=9000 → drawdown = 10%
		db.insert(riskState).values({ key: "peak_balance", value: "10000" }).run();
		db.insert(riskState).values({ key: "account_balance", value: "9000" }).run();
		db.insert(riskState).values({ key: "daily_pnl", value: "-300" }).run();
		db.insert(riskState).values({ key: "weekly_pnl", value: "-500" }).run();
		db.insert(riskState).values({ key: "circuit_breaker_tripped", value: "true" }).run();
		db.insert(riskState).values({ key: "daily_halt_active", value: "true" }).run();
		db.insert(riskState).values({ key: "weekly_drawdown_active", value: "false" }).run();

		db.insert(agentLogs)
			.values({
				level: "WARN",
				phase: "risk_guardian",
				message: "Daily loss limit approaching",
			})
			.run();

		const { getGuardianData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getGuardianData();

		expect(data.circuitBreaker.active).toBe(true);
		expect(data.dailyHalt.active).toBe(true);
		expect(data.weeklyDrawdown.active).toBe(false);

		expect(data.peakBalance).toBe(10000);
		expect(data.accountBalance).toBe(9000);

		// drawdownPct = (10000 - 9000) / 10000 * 100 = 10
		expect(data.circuitBreaker.drawdownPct).toBe(10);
		expect(data.circuitBreaker.limitPct).toBe(10);

		// dailyLossPct = abs(min(0, -300)) / 9000 * 100 = 300/9000*100 ≈ 3.3
		expect(data.dailyHalt.lossPct).toBe(Math.round(300 / 9000 * 100 * 10) / 10);
		expect(data.dailyHalt.limitPct).toBe(3);

		// weeklyLossPct = abs(min(0, -500)) / 9000 * 100 ≈ 5.6
		expect(data.weeklyDrawdown.lossPct).toBe(Math.round(500 / 9000 * 100 * 10) / 10);
		expect(data.weeklyDrawdown.limitPct).toBe(5);

		expect(data.checkHistory.length).toBe(1);
		expect(data.checkHistory[0]!.level).toBe("WARN");
		expect(data.checkHistory[0]!.message).toBe("Daily loss limit approaching");
	});
});
