import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("full evaluation cycle", () => {
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

	test("seeds strategies on first run", async () => {
		const { ensureSeedStrategies } = await import("../../src/strategy/seed.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		await ensureSeedStrategies();

		const strats = await db.select().from(strategies);
		expect(strats).toHaveLength(3);
		expect(strats[0]!.status).toBe("paper");
		expect(strats[0]!.signals).not.toBeNull();
		expect(strats[0]!.universe).not.toBeNull();
	});

	test("skips seeding when strategies already exist", async () => {
		const { ensureSeedStrategies } = await import("../../src/strategy/seed.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		await ensureSeedStrategies();
		await ensureSeedStrategies(); // second call should be no-op

		const strats = await db.select().from(strategies);
		expect(strats).toHaveLength(3);
	});

	test("full cycle: strategy + quote -> evaluate -> trade -> metrics", async () => {
		const { strategies, paperTrades, strategyMetrics } = await import("../../src/db/schema.ts");
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { recalculateMetrics } = await import("../../src/strategy/metrics.ts");

		// Insert a strategy that will trigger on any positive price
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "always_enter",
				description: "test: enters on any stock",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "last > 0",
					exit: "pnl_pct > 0.5 OR pnl_pct < -0.5",
				}),
				universe: JSON.stringify(["TEST"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Evaluate — should open a position
		await evaluateStrategyForSymbol(strat!, "TEST", "NASDAQ", {
			quote: {
				last: 100,
				bid: 99.5,
				ask: 100.5,
				volume: 1000000,
				avgVolume: 800000,
				changePercent: 0.5,
				newsSentiment: null,
			},
			indicators: { rsi14: 50, atr14: 2.0, volume_ratio: 1.25 },
		});

		let trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(1);
		expect(trades[0]!.side).toBe("BUY");

		// Evaluate again with higher price — should trigger exit (pnl_pct > 0.5)
		await evaluateStrategyForSymbol(strat!, "TEST", "NASDAQ", {
			quote: {
				last: 105,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
			},
			indicators: { rsi14: 60, atr14: 2.0, volume_ratio: 1.0 },
		});

		trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(2);
		const exitTrade = trades.find((t) => t.signalType === "exit");
		expect(exitTrade).not.toBeUndefined();
		expect(exitTrade!.pnl).not.toBeNull();
		expect(exitTrade!.pnl!).toBeGreaterThan(0);

		// Recalculate metrics
		await recalculateMetrics(strat!.id);

		const [metrics] = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strat!.id));
		expect(metrics).not.toBeUndefined();
		expect(metrics!.sampleSize).toBe(1);
		expect(metrics!.winRate).toBe(1);
	});
});
