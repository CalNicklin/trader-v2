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
