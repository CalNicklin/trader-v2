import { describe, expect, test } from "bun:test";
import type { DashboardData } from "../../src/monitoring/dashboard-data";
import { buildConsolePage, buildNewsPipelineTab } from "../../src/monitoring/status-page";

const baseData: DashboardData = {
	status: "ok",
	uptime: 3661,
	timestamp: new Date().toISOString(),
	paused: false,
	ibkrConnected: false,
	ibkrAccount: null,
	dailyPnl: 0,
	weeklyPnl: 0,
	dailyPnlLimit: 3,
	weeklyPnlLimit: 5,
	openPositionCount: 0,
	maxPositions: 3,
	tradesToday: 0,
	apiSpendToday: 0,
	apiBudget: 1,
	lastQuoteTime: null,
	strategies: [],
	positions: [],
	cronJobs: [],
	recentLogs: [],
	gitHash: "abc1234",
};

describe("buildConsolePage", () => {
	test("renders HTML with system status", () => {
		const html = buildConsolePage(baseData);
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("TRADER V2");
		expect(html).toContain("OK");
	});

	test("shows pause button when not paused", () => {
		const html = buildConsolePage({ ...baseData, paused: false });
		expect(html).toContain('action="/pause"');
		expect(html).toContain("PAUSE");
		expect(html).not.toContain('action="/resume"');
	});

	test("shows resume button when paused", () => {
		const html = buildConsolePage({ ...baseData, paused: true });
		expect(html).toContain('action="/resume"');
		expect(html).toContain("RESUME");
		expect(html).not.toContain('action="/pause"');
	});

	test("formats uptime in hours and minutes", () => {
		const html = buildConsolePage({ ...baseData, uptime: 3661 });
		expect(html).toContain("1h 1m");
	});

	test("formats uptime in minutes only when under one hour", () => {
		const html = buildConsolePage({ ...baseData, uptime: 185 });
		expect(html).toContain("3m");
		expect(html).not.toContain("0h");
	});

	test("shows IBKR connected with account ID", () => {
		const html = buildConsolePage({
			...baseData,
			ibkrConnected: true,
			ibkrAccount: "DUP924429",
		});
		expect(html).toContain("DUP924429");
	});

	test("shows strategy pipeline tier counts", () => {
		const html = buildConsolePage({
			...baseData,
			strategies: [
				{
					id: 1,
					name: "test",
					status: "paper",
					winRate: null,
					sharpeRatio: null,
					tradeCount: 0,
					universe: [],
				},
			],
		});
		expect(html).toContain("Strategy Pipeline");
		expect(html).toContain("Paper");
	});

	test("renders git hash in footer", () => {
		const html = buildConsolePage(baseData);
		expect(html).toContain("abc1234");
	});

	test("renders tab bar with overview active by default", () => {
		const html = buildConsolePage(baseData, "overview", "");
		expect(html).toContain("tab-bar");
		expect(html).toContain('href="/"');
		expect(html).toContain('href="/?tab=news"');
		expect(html).toContain('href="/?tab=guardian"');
		expect(html).toContain('href="/?tab=learning"');
		expect(html).toContain('href="/?tab=trades"');
	});

	test("preserves tab in meta refresh tag", () => {
		const html = buildConsolePage(baseData, "news", "<div>news content</div>");
		expect(html).toContain('content="30;url=/?tab=news"');
	});

	test("renders tab content instead of overview when tab is not overview", () => {
		const html = buildConsolePage(baseData, "news", "<div>NEWS_TAB_CONTENT</div>");
		expect(html).toContain("NEWS_TAB_CONTENT");
		expect(html).not.toContain("Strategy Pipeline");
	});

	test("preserves tab in pause/resume form action", () => {
		const html = buildConsolePage(baseData, "guardian", "<div>guardian</div>");
		expect(html).toContain('action="/pause?tab=guardian"');
	});

	test("renders positions with orphan tag", () => {
		const html = buildConsolePage({
			...baseData,
			openPositionCount: 1,
			positions: [
				{
					symbol: "HSBA",
					exchange: "LSE",
					quantity: -3909,
					avgCost: 13.91,
					unrealizedPnl: null,
					strategyId: null,
				},
			],
		});
		expect(html).toContain("HSBA:LSE");
		expect(html).toContain("SHORT");
		expect(html).toContain("orphan");
	});
});

describe("buildGuardianTab", () => {
	test("renders state cards and check history", () => {
		const { buildGuardianTab } = require("../../src/monitoring/status-page");
		const data = {
			circuitBreaker: { active: false, drawdownPct: 2.1, limitPct: 10 },
			dailyHalt: { active: true, lossPct: 3.2, limitPct: 3 },
			weeklyDrawdown: { active: false, lossPct: 1.2, limitPct: 5 },
			peakBalance: 10240,
			accountBalance: 10025,
			checkHistory: [
				{ time: "14:34", level: "INFO", message: "All clear" },
				{ time: "14:24", level: "WARN", message: "Daily loss approaching halt" },
			],
		};
		const html = buildGuardianTab(data);
		expect(html).toContain("CLEAR");
		expect(html).toContain("ACTIVE");
		expect(html).toContain("2.1%");
		expect(html).toContain("10%");
		expect(html).toContain("3.2%");
		expect(html).toContain("All clear");
		expect(html).toContain("Daily loss approaching halt");
	});

	test("shows tripped styling when circuit breaker active", () => {
		const { buildGuardianTab } = require("../../src/monitoring/status-page");
		const data = {
			circuitBreaker: { active: true, drawdownPct: 11.5, limitPct: 10 },
			dailyHalt: { active: false, lossPct: 0, limitPct: 3 },
			weeklyDrawdown: { active: false, lossPct: 0, limitPct: 5 },
			peakBalance: 10000,
			accountBalance: 8850,
			checkHistory: [],
		};
		const html = buildGuardianTab(data);
		expect(html).toContain("tripped");
		expect(html).toContain("ACTIVE");
	});
});

describe("buildLearningLoopTab", () => {
	test("renders summary and insight cards", () => {
		const { buildLearningLoopTab } = require("../../src/monitoring/status-page");
		const data = {
			insightsCount7d: 8,
			ledToImprovement: 3,
			patternsFound: 2,
			recentInsights: [
				{
					time: "21:30",
					insightType: "pattern_analysis",
					observation: "Monday underperformance in momentum",
					suggestedAction: null,
					confidence: 0.72,
					tags: ["timing", "momentum"],
					ledToImprovement: false,
				},
				{
					time: "21:15",
					insightType: "trade_review",
					observation: "Tightened stop-loss on mean-reversion-v4",
					suggestedAction: '{"parameter":"stop_loss","direction":"decrease"}',
					confidence: 0.85,
					tags: ["exits"],
					ledToImprovement: true,
				},
			],
		};
		const html = buildLearningLoopTab(data);
		expect(html).toContain("8");
		expect(html).toContain("3");
		expect(html).toContain("2");
		expect(html).toContain("Monday underperformance");
		expect(html).toContain("pattern_analysis");
		expect(html).toContain("0.72");
		expect(html).toContain("timing");
	});

	test("renders empty state", () => {
		const { buildLearningLoopTab } = require("../../src/monitoring/status-page");
		const data = {
			insightsCount7d: 0,
			ledToImprovement: 0,
			patternsFound: 0,
			recentInsights: [],
		};
		const html = buildLearningLoopTab(data);
		expect(html).toContain("No insights");
	});
});

describe("buildNewsPipelineTab", () => {
	test("renders summary stats and article rows", () => {
		const data = {
			totalArticles24h: 47,
			classifiedCount: 12,
			tradeableHighUrgency: 3,
			avgSentiment: 0.12,
			recentArticles: [
				{
					time: "14:22",
					symbols: ["SHEL.L"],
					headline: "Shell raises dividend 15%",
					sentiment: 0.82,
					confidence: 0.9,
					urgency: "high",
					eventType: "dividend",
					tradeable: true,
				},
			],
		};
		const html = buildNewsPipelineTab(data);
		expect(html).toContain("47");
		expect(html).toContain("12");
		expect(html).toContain("3");
		expect(html).toContain("+0.12");
		expect(html).toContain("Shell raises dividend 15%");
		expect(html).toContain("SHEL.L");
		expect(html).toContain("+0.82");
		expect(html).toContain("HIGH");
	});

	test("renders empty state when no articles", () => {
		const data = {
			totalArticles24h: 0,
			classifiedCount: 0,
			tradeableHighUrgency: 0,
			avgSentiment: 0,
			recentArticles: [],
		};
		const html = buildNewsPipelineTab(data);
		expect(html).toContain("0");
		expect(html).toContain("No articles");
	});
});
