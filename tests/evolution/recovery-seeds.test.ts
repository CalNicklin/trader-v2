import { beforeEach, describe, expect, test } from "bun:test";

describe("recovery seed injection", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { strategies, strategyMutations, strategyMetrics, paperTrades } = await import(
			"../../src/db/schema.ts"
		);
		await db.delete(paperTrades);
		await db.delete(strategyMutations);
		await db.delete(strategyMetrics);
		await db.delete(strategies);
	});

	test("injects a recovery seed when no strategies exist", async () => {
		const { injectRecoverySeed, RECOVERY_SEED_POOL } = await import(
			"../../src/evolution/recovery-seeds.ts"
		);
		const { strategies } = await import("../../src/db/schema.ts");

		const ids = await injectRecoverySeed(1);

		expect(ids.length).toBe(1);

		const all = await db.select().from(strategies).all();
		expect(all.length).toBe(1);
		expect(all[0]!.name).toBe(RECOVERY_SEED_POOL[0]!.name);
		expect(all[0]!.createdBy).toBe("recovery_seed");
		expect(all[0]!.status).toBe("paper");
		expect(all[0]!.virtualBalance).toBe(10_000);
	});

	test("skips seeds whose names already exist", async () => {
		const { injectRecoverySeed, RECOVERY_SEED_POOL } = await import(
			"../../src/evolution/recovery-seeds.ts"
		);
		const { strategies } = await import("../../src/db/schema.ts");

		await db.insert(strategies).values({
			name: RECOVERY_SEED_POOL[0]!.name,
			description: "Already exists",
			parameters: "{}",
			status: "paper" as const,
			virtualBalance: 10000,
			generation: 1,
		});

		const ids = await injectRecoverySeed(1);

		expect(ids.length).toBe(1);
		const all = await db.select().from(strategies).all();
		expect(all.length).toBe(2);
		expect(all[1]!.name).toBe(RECOVERY_SEED_POOL[1]!.name);
	});

	test("returns empty when all seeds are already used", async () => {
		const { injectRecoverySeed, RECOVERY_SEED_POOL } = await import(
			"../../src/evolution/recovery-seeds.ts"
		);
		const { strategies } = await import("../../src/db/schema.ts");

		for (const seed of RECOVERY_SEED_POOL) {
			await db.insert(strategies).values({
				name: seed.name,
				description: "Already exists",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			});
		}

		const ids = await injectRecoverySeed(1);
		expect(ids.length).toBe(0);
	});

	test("respects maxSeeds parameter", async () => {
		const { injectRecoverySeed } = await import("../../src/evolution/recovery-seeds.ts");

		const ids = await injectRecoverySeed(2);
		expect(ids.length).toBe(2);
	});

	test("recovery seeds have valid signal expressions", async () => {
		const { RECOVERY_SEED_POOL } = await import("../../src/evolution/recovery-seeds.ts");
		const { tokenize } = await import("../../src/strategy/expr-eval.ts");

		for (const seed of RECOVERY_SEED_POOL) {
			const signals = [seed.signals.entry_long, seed.signals.entry_short, seed.signals.exit].filter(
				Boolean,
			) as string[];
			for (const expr of signals) {
				expect(() => tokenize(expr)).not.toThrow();
			}
		}
	});

	test("recovery seeds include stop_loss_pct", async () => {
		const { RECOVERY_SEED_POOL } = await import("../../src/evolution/recovery-seeds.ts");

		for (const seed of RECOVERY_SEED_POOL) {
			expect(seed.parameters.stop_loss_pct).toBeGreaterThan(0);
		}
	});
});
