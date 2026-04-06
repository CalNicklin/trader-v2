import { beforeEach, describe, expect, test } from "bun:test";

describe("graduation gate", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("strategy passes graduation with strong metrics", async () => {
		const { checkGraduation } = await import("../../src/strategy/graduation.ts");
		const { strategies, strategyMetrics, paperTrades } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "strong",
				description: "test",
				parameters: JSON.stringify({ a: 1, b: 2 }),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strat!.id,
			sampleSize: 35,
			winRate: 0.6,
			expectancy: 25,
			profitFactor: 1.8,
			sharpeRatio: 1.2,
			sortinoRatio: 1.5,
			maxDrawdownPct: 8,
			calmarRatio: 1.5,
			consistencyScore: 3,
		});

		// Insert 35 trades for walk-forward validation (most are profitable)
		for (let i = 0; i < 35; i++) {
			const tradeDate = new Date();
			tradeDate.setDate(tradeDate.getDate() - (35 - i));
			await db.insert(paperTrades).values({
				strategyId: strat!.id,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "SELL" as const,
				quantity: 10,
				price: 150,
				friction: 0.3,
				pnl: i % 3 === 0 ? -10 : 30, // mostly winners
				signalType: "exit",
				reasoning: "test",
				createdAt: tradeDate.toISOString(),
			});
		}

		const result = await checkGraduation(strat!.id);
		expect(result.passes).toBe(true);
		expect(result.failures).toHaveLength(0);
	});

	test("strategy fails graduation with insufficient sample", async () => {
		const { checkGraduation } = await import("../../src/strategy/graduation.ts");
		const { strategies, strategyMetrics } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "small_sample",
				description: "test",
				parameters: JSON.stringify({ a: 1, b: 2 }),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strat!.id,
			sampleSize: 15,
			winRate: 0.8,
			expectancy: 50,
			profitFactor: 3.0,
			sharpeRatio: 2.0,
			sortinoRatio: 2.5,
			maxDrawdownPct: 5,
			calmarRatio: 2.0,
			consistencyScore: 4,
		});

		const result = await checkGraduation(strat!.id);
		expect(result.passes).toBe(false);
		expect(result.failures.some((f) => f.includes("sample"))).toBe(true);
	});

	test("graduates strategy meeting reduced trade count with tighter thresholds", async () => {
		const { checkGraduation } = await import("../../src/strategy/graduation.ts");
		const { strategies, strategyMetrics, paperTrades } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const [strategy] = await db
			.insert(strategies)
			.values({
				name: "grad_test_pass",
				description: "Test strategy for graduation",
				parameters: JSON.stringify({ hold_days: 2, sentiment_threshold: 0.5 }),
				signals: JSON.stringify({ entry_long: "news_sentiment > 0.5", exit: "hold_days >= 2" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				createdBy: "evolution",
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strategy!.id,
			sampleSize: 20,
			expectancy: 0.5,
			profitFactor: 1.5, // Tighter: was 1.3
			sharpeRatio: 0.7, // Tighter: was 0.5
			maxDrawdownPct: 12,
			consistencyScore: 3,
			winRate: 0.6,
		});

		// Insert enough paper trades for walk-forward validation
		for (let i = 0; i < 20; i++) {
			await db.insert(paperTrades).values({
				strategyId: strategy!.id,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "BUY" as const,
				price: 150,
				quantity: 1,
				signalType: "exit",
				pnl: i % 3 === 0 ? -0.5 : 1.0,
			});
		}

		const result = await checkGraduation(strategy!.id);
		expect(result.passes).toBe(true);

		// Cleanup
		await db.delete(paperTrades).where(eq(paperTrades.strategyId, strategy!.id));
		await db.delete(strategyMetrics).where(eq(strategyMetrics.strategyId, strategy!.id));
		await db.delete(strategies).where(eq(strategies.id, strategy!.id));
	});

	test("rejects strategy with 20 trades but old thresholds", async () => {
		const { checkGraduation } = await import("../../src/strategy/graduation.ts");
		const { strategies, strategyMetrics } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const [strategy] = await db
			.insert(strategies)
			.values({
				name: "grad_test_fail",
				description: "Test strategy that should fail new thresholds",
				parameters: JSON.stringify({ hold_days: 2 }),
				signals: JSON.stringify({ entry_long: "last > 0", exit: "hold_days >= 2" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				createdBy: "evolution",
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strategy!.id,
			sampleSize: 20,
			expectancy: 0.1,
			profitFactor: 1.31, // Would have passed old gate (1.3) but fails new (1.5)
			sharpeRatio: 0.51, // Would have passed old gate (0.5) but fails new (0.7)
			maxDrawdownPct: 14,
			consistencyScore: 3,
			winRate: 0.5,
		});

		const result = await checkGraduation(strategy!.id);
		expect(result.passes).toBe(false);

		// Cleanup
		await db.delete(strategyMetrics).where(eq(strategyMetrics.strategyId, strategy!.id));
		await db.delete(strategies).where(eq(strategies.id, strategy!.id));
	});

	test("strategy fails multiple criteria", async () => {
		const { checkGraduation } = await import("../../src/strategy/graduation.ts");
		const { strategies, strategyMetrics } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "weak",
				description: "test",
				parameters: JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strat!.id,
			sampleSize: 35,
			winRate: 0.3,
			expectancy: -5,
			profitFactor: 0.8,
			sharpeRatio: 0.2,
			sortinoRatio: 0.3,
			maxDrawdownPct: 20,
			calmarRatio: 0.5,
			consistencyScore: 1,
		});

		const result = await checkGraduation(strat!.id);
		expect(result.passes).toBe(false);
		expect(result.failures.length).toBeGreaterThan(3);
	});
});
