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
