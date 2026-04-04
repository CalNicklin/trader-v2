import { beforeEach, describe, expect, test } from "bun:test";

describe("evolution population manager", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { graduationEvents, strategyMetrics, strategies } = await import(
			"../../src/db/schema.ts"
		);
		await db.delete(graduationEvents);
		await db.delete(strategyMetrics);
		await db.delete(strategies);
	});

	// ── Helpers ─────────────────────────────────────────────────────────────────

	async function insertStrategy(
		name: string,
		status: "paper" | "probation" | "active" | "core" | "retired" = "paper",
	): Promise<number> {
		const { strategies } = await import("../../src/db/schema.ts");
		const [row] = await db
			.insert(strategies)
			.values({
				name,
				description: `Test strategy: ${name}`,
				parameters: "{}",
				status: status as "paper",
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();
		return row!.id;
	}

	async function insertMetrics(
		strategyId: number,
		opts: { maxDrawdownPct?: number; sharpeRatio?: number } = {},
	): Promise<void> {
		const { strategyMetrics } = await import("../../src/db/schema.ts");
		await db.insert(strategyMetrics).values({
			strategyId,
			sampleSize: 10,
			maxDrawdownPct: opts.maxDrawdownPct ?? null,
			sharpeRatio: opts.sharpeRatio ?? null,
		});
	}

	// ── checkDrawdowns ───────────────────────────────────────────────────────────

	test("checkDrawdowns retires paper strategy exceeding 15% drawdown", async () => {
		const { checkDrawdowns } = await import("../../src/evolution/population.ts");
		const { strategies, graduationEvents } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const id = await insertStrategy("bad-drawdown");
		await insertMetrics(id, { maxDrawdownPct: 20 });

		const killed = await checkDrawdowns();

		expect(killed).toEqual([id]);

		const strategy = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(strategy?.status).toBe("retired");
		expect(strategy?.retiredAt).toBeTruthy();

		const events = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, id))
			.all();
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe("killed");
	});

	test("checkDrawdowns does not retire strategy under 15% drawdown", async () => {
		const { checkDrawdowns } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const id = await insertStrategy("safe-drawdown");
		await insertMetrics(id, { maxDrawdownPct: 10 });

		const killed = await checkDrawdowns();

		expect(killed).toEqual([]);

		const strategy = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(strategy?.status).toBe("paper");
	});

	test("checkDrawdowns does not retire exactly at 15% (boundary)", async () => {
		const { checkDrawdowns } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const id = await insertStrategy("boundary-drawdown");
		await insertMetrics(id, { maxDrawdownPct: 15 });

		const killed = await checkDrawdowns();

		expect(killed).toEqual([]);

		const strategy = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(strategy?.status).toBe("paper");
	});

	test("checkDrawdowns only checks paper strategies — retired strategy with high drawdown is not killed again", async () => {
		const { checkDrawdowns } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const id = await insertStrategy("already-retired", "retired");
		await insertMetrics(id, { maxDrawdownPct: 50 });

		const killed = await checkDrawdowns();

		expect(killed).toEqual([]);

		// Status must remain retired (not doubly-processed)
		const strategy = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(strategy?.status).toBe("retired");
	});

	test("checkDrawdowns only kills paper strategies — probation/active/core are not checked", async () => {
		const { checkDrawdowns } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const probationId = await insertStrategy("bad-probation", "probation");
		await insertMetrics(probationId, { maxDrawdownPct: 30 });

		const killed = await checkDrawdowns();
		expect(killed).toEqual([]);

		const strategy = await db.select().from(strategies).where(eq(strategies.id, probationId)).get();
		expect(strategy?.status).toBe("probation");
	});

	// ── enforcePopulationCap ─────────────────────────────────────────────────────

	test("enforcePopulationCap does nothing when at or under cap", async () => {
		const { enforcePopulationCap, MAX_POPULATION } = await import(
			"../../src/evolution/population.ts"
		);

		// Insert exactly MAX_POPULATION strategies
		for (let i = 0; i < MAX_POPULATION; i++) {
			const id = await insertStrategy(`strategy-${i}`);
			await insertMetrics(id, { sharpeRatio: i * 0.1 });
		}

		const culled = await enforcePopulationCap();
		expect(culled).toEqual([]);
	});

	test("enforcePopulationCap culls worst Sharpe when over cap", async () => {
		const { enforcePopulationCap, MAX_POPULATION } = await import(
			"../../src/evolution/population.ts"
		);
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		// Insert MAX_POPULATION + 2 strategies with distinct Sharpe ratios
		const ids: number[] = [];
		const sharpes = [0.5, 1.2, -0.3, 2.1, 0.8, 1.5, 0.1, 0.9, 1.8, 0.4];
		for (let i = 0; i < MAX_POPULATION + 2; i++) {
			const id = await insertStrategy(`strategy-${i}`);
			await insertMetrics(id, { sharpeRatio: sharpes[i] });
			ids.push(id);
		}

		const culled = await enforcePopulationCap();

		// Should have culled exactly 2 strategies
		expect(culled).toHaveLength(2);

		// The 2 worst Sharpe values are -0.3 (index 2) and 0.1 (index 6)
		const sharpeMap = new Map(ids.map((id, i) => [id, sharpes[i]!]));
		const culledSharpes = culled.map((id) => sharpeMap.get(id)!);
		culledSharpes.sort((a, b) => a - b);
		expect(culledSharpes[0]).toBeCloseTo(-0.3, 5);
		expect(culledSharpes[1]).toBeCloseTo(0.1, 5);

		// Culled strategies must be retired
		for (const id of culled) {
			const s = await db.select().from(strategies).where(eq(strategies.id, id)).get();
			expect(s?.status).toBe("retired");
		}
	});

	test("enforcePopulationCap treats null Sharpe as worst", async () => {
		const { enforcePopulationCap, MAX_POPULATION } = await import(
			"../../src/evolution/population.ts"
		);
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		// Insert MAX_POPULATION + 1 strategies; one has no metrics (null Sharpe)
		const idsWithSharpe: number[] = [];
		for (let i = 0; i < MAX_POPULATION; i++) {
			const id = await insertStrategy(`strategy-with-sharpe-${i}`);
			await insertMetrics(id, { sharpeRatio: i * 0.2 + 0.5 });
			idsWithSharpe.push(id);
		}
		const noMetricsId = await insertStrategy("strategy-no-metrics");
		// no metrics inserted — sharpe is null

		const culled = await enforcePopulationCap();

		// Should cull exactly 1 — the one with null Sharpe
		expect(culled).toHaveLength(1);
		expect(culled[0]).toBe(noMetricsId);

		const s = await db.select().from(strategies).where(eq(strategies.id, noMetricsId)).get();
		expect(s?.status).toBe("retired");
	});
});
