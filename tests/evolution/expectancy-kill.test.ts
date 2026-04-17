import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("checkExpectancyKill", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { graduationEvents, strategyMetrics, strategies, paperTrades } = await import(
			"../../src/db/schema.ts"
		);
		await db.delete(graduationEvents);
		await db.delete(strategyMetrics);
		await db.delete(paperTrades);
		await db.delete(strategies);
	});

	async function insertStrategyWithBackHalfPnl(
		sharpe: number,
		sampleSize: number,
		backHalfPnl: number,
	) {
		const { strategies, strategyMetrics, paperTrades } = await import("../../src/db/schema.ts");
		const [row] = await db
			.insert(strategies)
			.values({
				name: "bad_strat",
				description: "x",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();
		const id = row!.id;
		await db.insert(strategyMetrics).values({
			strategyId: id,
			sampleSize,
			sharpeRatio: sharpe,
			maxDrawdownPct: 2,
		});
		const halfCount = Math.ceil(sampleSize / 2);
		const trades = Array.from({ length: sampleSize }, (_, i) => ({
			strategyId: id,
			symbol: "TEST",
			exchange: "NASDAQ",
			side: "BUY" as const,
			quantity: 1,
			price: 100,
			friction: 0,
			pnl: i >= Math.floor(sampleSize / 2) ? backHalfPnl / halfCount : -10,
			signalType: "exit",
		}));
		for (const t of trades) await db.insert(paperTrades).values(t);
		return id;
	}

	test("retires strategy with negative Sharpe and confirming back-half at n>=20", async () => {
		const { checkExpectancyKill } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const id = await insertStrategyWithBackHalfPnl(-3, 20, -40);

		const killed = await checkExpectancyKill();

		expect(killed).toEqual([id]);
		const [row] = await db.select().from(strategies).where(eq(strategies.id, id));
		expect(row?.status).toBe("retired");
	});

	test("does NOT retire when back-half shows recovery", async () => {
		const { checkExpectancyKill } = await import("../../src/evolution/population.ts");
		const _id = await insertStrategyWithBackHalfPnl(-3, 25, 20);

		const killed = await checkExpectancyKill();

		expect(killed).toEqual([]);
	});

	test("does NOT retire at n<20 even with bad Sharpe", async () => {
		const { checkExpectancyKill } = await import("../../src/evolution/population.ts");
		const _id = await insertStrategyWithBackHalfPnl(-15, 19, -50);

		const killed = await checkExpectancyKill();

		expect(killed).toEqual([]);
	});
});
