import { describe, expect, test } from "bun:test";
import type { DashboardData } from "../../src/monitoring/dashboard-data";
import { buildConsolePage } from "../../src/monitoring/status-page";

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
