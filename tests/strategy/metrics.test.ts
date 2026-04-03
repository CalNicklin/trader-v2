import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("strategy metrics", () => {
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

	async function insertStrategyAndTrades(pnls: number[]) {
		const { strategies, paperTrades } = await import("../../src/db/schema.ts");
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test",
				description: "test",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		for (let i = 0; i < pnls.length; i++) {
			// Insert exit trades with P&L values (metrics only look at trades with pnl)
			const weekOffset = Math.floor(i / 5); // spread trades across weeks
			const tradeDate = new Date();
			tradeDate.setDate(tradeDate.getDate() - (pnls.length - i) - weekOffset * 2);

			await db.insert(paperTrades).values({
				strategyId: strat!.id,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "SELL" as const,
				quantity: 10,
				price: 150,
				friction: 0.3,
				pnl: pnls[i]!,
				signalType: "exit",
				reasoning: "test",
				createdAt: tradeDate.toISOString(),
			});
		}
		return strat!;
	}

	test("calculates metrics for strategy with mixed wins/losses", async () => {
		const { recalculateMetrics } = await import("../../src/strategy/metrics.ts");
		const { strategyMetrics } = await import("../../src/db/schema.ts");

		// 10 trades: 6 wins, 4 losses
		const pnls = [50, -20, 30, -15, 45, -25, 60, 40, -10, 35];
		const strat = await insertStrategyAndTrades(pnls);

		await recalculateMetrics(strat.id);

		const [metrics] = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strat.id));

		expect(metrics).not.toBeUndefined();
		expect(metrics!.sampleSize).toBe(10);
		expect(metrics!.winRate).toBeCloseTo(0.6, 2); // 6/10
		expect(metrics!.expectancy).toBeCloseTo(19, 0); // avg P&L = 190/10
		expect(metrics!.profitFactor).toBeGreaterThan(1); // gross profit / gross loss
	});

	test("calculates zero metrics with no trades", async () => {
		const { recalculateMetrics } = await import("../../src/strategy/metrics.ts");
		const { strategyMetrics, strategies } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "empty",
				description: "test",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await recalculateMetrics(strat!.id);

		const [metrics] = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strat!.id));

		expect(metrics).not.toBeUndefined();
		expect(metrics!.sampleSize).toBe(0);
		expect(metrics!.winRate).toBeNull();
	});

	test("updates existing metrics on recalculation", async () => {
		const { recalculateMetrics } = await import("../../src/strategy/metrics.ts");
		const { strategyMetrics } = await import("../../src/db/schema.ts");

		const strat = await insertStrategyAndTrades([50, -20, 30]);
		await recalculateMetrics(strat.id);
		await recalculateMetrics(strat.id); // second call updates

		const rows = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strat.id));

		expect(rows).toHaveLength(1); // should be upserted, not duplicated
	});
});
