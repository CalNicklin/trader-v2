import { beforeEach, describe, expect, it } from "bun:test";

describe("runTournaments", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { graduationEvents, strategyMutations, strategyMetrics, strategies } = await import(
			"../../src/db/schema.ts"
		);
		// Delete in FK-safe order
		await db.delete(graduationEvents);
		await db.delete(strategyMutations);
		await db.delete(strategyMetrics);
		await db.delete(strategies);
	});

	// ── Helpers ─────────────────────────────────────────────────────────────────

	async function insertStrategy(
		name: string,
		opts: { status?: "paper" | "probation" | "active" | "core" | "retired" } = {},
	): Promise<number> {
		const { strategies } = await import("../../src/db/schema.ts");
		const [row] = await db
			.insert(strategies)
			.values({
				name,
				description: `Test strategy: ${name}`,
				parameters: "{}",
				status: (opts.status ?? "paper") as "paper",
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();
		return row!.id;
	}

	async function insertMetrics(
		strategyId: number,
		sampleSize: number,
		sharpe: number | null,
	): Promise<void> {
		const { strategyMetrics } = await import("../../src/db/schema.ts");
		await db
			.insert(strategyMetrics)
			.values({
				strategyId,
				sampleSize,
				sharpeRatio: sharpe,
			})
			.onConflictDoUpdate({
				target: strategyMetrics.strategyId,
				set: { sampleSize, sharpeRatio: sharpe },
			});
	}

	async function insertMutation(parentId: number, childId: number): Promise<number> {
		const { strategyMutations } = await import("../../src/db/schema.ts");
		const [row] = await db
			.insert(strategyMutations)
			.values({
				parentId,
				childId,
				mutationType: "parameter_tweak" as const,
			})
			.returning();
		return row!.id;
	}

	// ── Tests ────────────────────────────────────────────────────────────────────

	it("child wins when higher Sharpe — parent retires, mutation record updated with Sharpe values", async () => {
		const { runTournaments } = await import("../../src/evolution/tournament.ts");
		const { strategies, strategyMutations, graduationEvents } = await import(
			"../../src/db/schema.ts"
		);
		const { eq } = await import("drizzle-orm");

		const parentId = await insertStrategy("parent-strategy");
		const childId = await insertStrategy("child-strategy");
		await insertMetrics(parentId, 30, 0.8);
		await insertMetrics(childId, 30, 1.5);
		const mutationId = await insertMutation(parentId, childId);

		const results = await runTournaments();

		expect(results).toHaveLength(1);
		const result = results[0]!;
		expect(result.parentId).toBe(parentId);
		expect(result.childId).toBe(childId);
		expect(result.winnerId).toBe(childId);
		expect(result.loserId).toBe(parentId);
		expect(result.parentSharpe).toBeCloseTo(0.8, 5);
		expect(result.childSharpe).toBeCloseTo(1.5, 5);

		// Parent should be retired
		const parent = await db.select().from(strategies).where(eq(strategies.id, parentId)).get();
		expect(parent?.status).toBe("retired");
		expect(parent?.retiredAt).toBeTruthy();

		// Child should still be active (paper)
		const child = await db.select().from(strategies).where(eq(strategies.id, childId)).get();
		expect(child?.status).toBe("paper");

		// Mutation record updated with Sharpe values
		const mutation = await db
			.select()
			.from(strategyMutations)
			.where(eq(strategyMutations.id, mutationId))
			.get();
		expect(mutation?.parentSharpe).toBeCloseTo(0.8, 5);
		expect(mutation?.childSharpe).toBeCloseTo(1.5, 5);

		// Graduation event inserted for loser (parent)
		const events = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, parentId))
			.all();
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe("killed");
	});

	it("parent wins when higher Sharpe — child retires", async () => {
		const { runTournaments } = await import("../../src/evolution/tournament.ts");
		const { strategies, graduationEvents } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const parentId = await insertStrategy("parent-strong");
		const childId = await insertStrategy("child-weak");
		await insertMetrics(parentId, 30, 2.1);
		await insertMetrics(childId, 30, 0.4);
		await insertMutation(parentId, childId);

		const results = await runTournaments();

		expect(results).toHaveLength(1);
		const result = results[0]!;
		expect(result.winnerId).toBe(parentId);
		expect(result.loserId).toBe(childId);

		// Child should be retired
		const child = await db.select().from(strategies).where(eq(strategies.id, childId)).get();
		expect(child?.status).toBe("retired");
		expect(child?.retiredAt).toBeTruthy();

		// Parent should remain active
		const parent = await db.select().from(strategies).where(eq(strategies.id, parentId)).get();
		expect(parent?.status).toBe("paper");

		// Graduation event for child
		const events = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, childId))
			.all();
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe("killed");
	});

	it("skips pairs where either has fewer than 30 trades", async () => {
		const { runTournaments, MIN_TRADES_FOR_TOURNAMENT } = await import(
			"../../src/evolution/tournament.ts"
		);
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const parentId = await insertStrategy("parent-not-ready");
		const childId = await insertStrategy("child-not-ready");
		// Parent has 29 trades (just under threshold), child has 30
		await insertMetrics(parentId, MIN_TRADES_FOR_TOURNAMENT - 1, 1.0);
		await insertMetrics(childId, MIN_TRADES_FOR_TOURNAMENT, 1.5);
		await insertMutation(parentId, childId);

		const results = await runTournaments();

		expect(results).toHaveLength(0);

		// Neither strategy should be retired
		const parent = await db.select().from(strategies).where(eq(strategies.id, parentId)).get();
		const child = await db.select().from(strategies).where(eq(strategies.id, childId)).get();
		expect(parent?.status).toBe("paper");
		expect(child?.status).toBe("paper");
	});

	it("skips pairs where one is already retired", async () => {
		const { runTournaments } = await import("../../src/evolution/tournament.ts");
		const { strategies, graduationEvents } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const parentId = await insertStrategy("parent-retired", { status: "retired" });
		const childId = await insertStrategy("child-active");
		await insertMetrics(parentId, 30, 1.0);
		await insertMetrics(childId, 30, 1.5);
		await insertMutation(parentId, childId);

		const results = await runTournaments();

		expect(results).toHaveLength(0);

		// Child should not be affected
		const child = await db.select().from(strategies).where(eq(strategies.id, childId)).get();
		expect(child?.status).toBe("paper");

		// No graduation events should have been inserted
		const events = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, childId))
			.all();
		expect(events).toHaveLength(0);
	});
});
