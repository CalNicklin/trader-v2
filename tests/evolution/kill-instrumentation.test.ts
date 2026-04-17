import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("kill-event instrumentation (Proposal #12)", () => {
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

	test("kill evidence JSON contains killFillDurationMs and killLegsCount reflecting closed positions", async () => {
		const { strategies, strategyMetrics, paperPositions, graduationEvents } = await import(
			"../../src/db/schema.ts"
		);
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "bad",
				description: "x",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();
		const id = strat!.id;
		await db.insert(strategyMetrics).values({ strategyId: id, sampleSize: 15, maxDrawdownPct: 20 });
		for (let i = 0; i < 2; i++) {
			await db.insert(paperPositions).values({
				strategyId: id,
				symbol: `SYM${i}`,
				exchange: "NASDAQ",
				side: "BUY",
				quantity: 1,
				entryPrice: 100,
				currentPrice: 95,
			});
		}

		const { checkDrawdowns } = await import("../../src/evolution/population.ts");
		await checkDrawdowns();

		const [event] = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, id));
		expect(event).toBeTruthy();
		const evidence = JSON.parse(event!.evidence!);
		expect(evidence).toHaveProperty("killFillDurationMs");
		expect(evidence).toHaveProperty("killLegsCount");
		expect(evidence.killLegsCount).toBe(2);
		expect(typeof evidence.killFillDurationMs).toBe("number");
		expect(evidence.killFillDurationMs).toBeGreaterThanOrEqual(0);
		expect(evidence.reason).toMatch(/drawdown/i);
	});

	test("kill evidence on a strategy with zero positions reports killLegsCount=0", async () => {
		const { strategies, strategyMetrics, graduationEvents } = await import(
			"../../src/db/schema.ts"
		);
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "bad_no_positions",
				description: "x",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();
		const id = strat!.id;
		await db.insert(strategyMetrics).values({ strategyId: id, sampleSize: 15, maxDrawdownPct: 20 });

		const { checkDrawdowns } = await import("../../src/evolution/population.ts");
		await checkDrawdowns();

		const [event] = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, id));
		expect(event).toBeTruthy();
		const evidence = JSON.parse(event!.evidence!);
		expect(evidence.killLegsCount).toBe(0);
	});
});
