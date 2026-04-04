import { beforeEach, describe, expect, test } from "bun:test";

describe("evolution analyzer", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { paperTrades, strategyMetrics, strategies } = await import("../../src/db/schema.ts");
		await db.delete(paperTrades);
		await db.delete(strategyMetrics);
		await db.delete(strategies);
	});

	test("getStrategyPerformance returns null for missing strategy", async () => {
		const { getStrategyPerformance } = await import("../../src/evolution/analyzer.ts");
		const result = await getStrategyPerformance(99999);
		expect(result).toBeNull();
	});

	test("getStrategyPerformance returns full performance data with parsed JSON fields", async () => {
		const { strategies, strategyMetrics } = await import("../../src/db/schema.ts");
		const { getStrategyPerformance } = await import("../../src/evolution/analyzer.ts");

		const [strategy] = await db
			.insert(strategies)
			.values({
				name: "momentum-v1",
				description: "Momentum strategy",
				parameters: JSON.stringify({ lookback: 20, threshold: 0.02 }),
				signals: JSON.stringify({ entry_long: "rsi > 60", exit: "rsi < 40" }),
				universe: JSON.stringify(["AAPL", "MSFT"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 2,
				createdBy: "evolution",
				parentStrategyId: null,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strategy!.id,
			sampleSize: 30,
			winRate: 0.6,
			expectancy: 25.5,
			profitFactor: 1.8,
			sharpeRatio: 1.2,
			sortinoRatio: 1.5,
			maxDrawdownPct: 0.12,
			calmarRatio: 0.9,
			consistencyScore: 3,
		});

		const result = await getStrategyPerformance(strategy!.id);

		expect(result).not.toBeNull();
		expect(result!.id).toBe(strategy!.id);
		expect(result!.name).toBe("momentum-v1");
		expect(result!.status).toBe("paper");
		expect(result!.generation).toBe(2);
		expect(result!.createdBy).toBe("evolution");
		expect(result!.virtualBalance).toBe(10000);

		// parsed parameters
		expect(result!.parameters).toEqual({ lookback: 20, threshold: 0.02 });

		// parsed signals
		expect(result!.signals).toEqual({ entry_long: "rsi > 60", exit: "rsi < 40" });

		// parsed universe
		expect(result!.universe).toEqual(["AAPL", "MSFT"]);

		// metrics
		expect(result!.metrics).not.toBeNull();
		expect(result!.metrics!.sampleSize).toBe(30);
		expect(result!.metrics!.winRate).toBeCloseTo(0.6, 5);
		expect(result!.metrics!.expectancy).toBeCloseTo(25.5, 5);
		expect(result!.metrics!.sharpeRatio).toBeCloseTo(1.2, 5);
		expect(result!.metrics!.consistencyScore).toBe(3);
	});

	test("getStrategyPerformance returns null metrics when no metrics row exists", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { getStrategyPerformance } = await import("../../src/evolution/analyzer.ts");

		const [strategy] = await db
			.insert(strategies)
			.values({
				name: "new-strategy",
				description: "Brand new",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		const result = await getStrategyPerformance(strategy!.id);

		expect(result).not.toBeNull();
		expect(result!.metrics).toBeNull();
	});

	test("getStrategyPerformance includes recent trades", async () => {
		const { strategies, paperTrades } = await import("../../src/db/schema.ts");
		const { getStrategyPerformance } = await import("../../src/evolution/analyzer.ts");

		const [strategy] = await db
			.insert(strategies)
			.values({
				name: "trade-test",
				description: "Test",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(paperTrades).values([
			{
				strategyId: strategy!.id,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "BUY" as const,
				quantity: 10,
				price: 150,
				friction: 0,
				pnl: null,
				signalType: "entry_long",
				createdAt: "2026-04-01T10:00:00.000Z",
			},
			{
				strategyId: strategy!.id,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "SELL" as const,
				quantity: 10,
				price: 160,
				friction: 0.3,
				pnl: 99.7,
				signalType: "exit",
				createdAt: "2026-04-02T10:00:00.000Z",
			},
		]);

		const result = await getStrategyPerformance(strategy!.id);

		expect(result).not.toBeNull();
		expect(result!.recentTrades).toHaveLength(2);
		// ordered by createdAt desc — most recent first
		expect(result!.recentTrades[0]!.symbol).toBe("AAPL");
		expect(result!.recentTrades[0]!.side).toBe("SELL");
		expect(result!.recentTrades[0]!.pnl).toBeCloseTo(99.7, 2);
	});

	test("getPerformanceLandscape excludes retired strategies", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { getPerformanceLandscape } = await import("../../src/evolution/analyzer.ts");

		await db.insert(strategies).values([
			{
				name: "active-strategy",
				description: "Active",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			},
			{
				name: "retired-strategy",
				description: "Retired",
				parameters: "{}",
				status: "retired" as const,
				virtualBalance: 10000,
				generation: 1,
				retiredAt: new Date().toISOString(),
			},
			{
				name: "active-strategy-2",
				description: "Probation",
				parameters: "{}",
				status: "probation" as const,
				virtualBalance: 10000,
				generation: 1,
			},
		]);

		const landscape = await getPerformanceLandscape();

		expect(landscape.strategies).toHaveLength(2);
		expect(landscape.strategies.every((s) => s.status !== "retired")).toBe(true);
		expect(landscape.timestamp).toBeTruthy();
	});

	test("getPerformanceLandscape counts paper strategies correctly", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { getPerformanceLandscape } = await import("../../src/evolution/analyzer.ts");

		await db.insert(strategies).values([
			{
				name: "paper-1",
				description: "Paper 1",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			},
			{
				name: "paper-2",
				description: "Paper 2",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			},
			{
				name: "active-1",
				description: "Active 1",
				parameters: "{}",
				status: "active" as const,
				virtualBalance: 10000,
				generation: 1,
			},
		]);

		const landscape = await getPerformanceLandscape();

		expect(landscape.activePaperCount).toBe(2);
		expect(landscape.strategies).toHaveLength(3);
	});
});
