import { beforeEach, describe, expect, it } from "bun:test";
import type { ValidatedMutation } from "../../src/evolution/types";

describe("spawnChild", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { strategyMutations, strategies } = await import("../../src/db/schema.ts");
		// Delete mutations first (FK references strategies)
		await db.delete(strategyMutations);
		await db.delete(strategies);
	});

	it("creates child strategy with correct fields", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { spawnChild } = await import("../../src/evolution/spawner.ts");

		const [parent] = await db
			.insert(strategies)
			.values({
				name: "parent-strategy",
				description: "Parent strategy",
				parameters: JSON.stringify({ stop_loss_pct: 3, hold_days: 5 }),
				signals: JSON.stringify({ entry_long: "rsi < 30", exit: "rsi > 60" }),
				universe: JSON.stringify(["AAPL", "MSFT"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			})
			.returning();

		const mutation: ValidatedMutation = {
			parentId: parent!.id,
			type: "parameter_tweak",
			name: "child-strategy",
			description: "A tweaked child",
			parameters: { stop_loss_pct: 4, hold_days: 7 },
			signals: { entry_long: "rsi < 30", exit: "rsi > 60" },
			universe: ["AAPL", "MSFT"],
			parameterDiff: {
				stop_loss_pct: { from: 3, to: 4 },
				hold_days: { from: 5, to: 7 },
			},
		};

		const childId = await spawnChild(mutation);

		const [child] = await db
			.select()
			.from(strategies)
			.where((await import("drizzle-orm")).eq(strategies.id, childId));

		expect(child).not.toBeUndefined();
		expect(child!.name).toBe("child-strategy");
		expect(child!.description).toBe("A tweaked child");
		expect(child!.parentStrategyId).toBe(parent!.id);
		expect(child!.generation).toBe(2); // parent gen 1 + 1
		expect(child!.createdBy).toBe("evolution");
		expect(child!.status).toBe("paper");
		expect(JSON.parse(child!.parameters)).toEqual({ stop_loss_pct: 4, hold_days: 7 });
	});

	it("records mutation in strategy_mutations table", async () => {
		const { strategies, strategyMutations } = await import("../../src/db/schema.ts");
		const { spawnChild } = await import("../../src/evolution/spawner.ts");

		const [parent] = await db
			.insert(strategies)
			.values({
				name: "parent-for-mutation",
				description: "Parent",
				parameters: JSON.stringify({ stop_loss_pct: 3 }),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		const mutation: ValidatedMutation = {
			parentId: parent!.id,
			type: "new_variant",
			name: "variant-child",
			description: "A new variant",
			parameters: { stop_loss_pct: 5 },
			signals: { entry_long: "sentiment > 0.8", exit: "hold_days > 10" },
			universe: ["TSLA"],
			parameterDiff: { stop_loss_pct: { from: 3, to: 5 } },
		};

		const childId = await spawnChild(mutation);

		const { eq } = await import("drizzle-orm");
		const [mutationRow] = await db
			.select()
			.from(strategyMutations)
			.where(eq(strategyMutations.childId, childId));

		expect(mutationRow).not.toBeUndefined();
		expect(mutationRow!.parentId).toBe(parent!.id);
		expect(mutationRow!.childId).toBe(childId);
		expect(mutationRow!.mutationType).toBe("new_variant");
		expect(JSON.parse(mutationRow!.parameterDiff!)).toEqual({
			stop_loss_pct: { from: 3, to: 5 },
		});
	});

	it("inherits parent virtualBalance and increments generation correctly", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { spawnChild } = await import("../../src/evolution/spawner.ts");

		const [parent] = await db
			.insert(strategies)
			.values({
				name: "gen3-strategy",
				description: "Generation 3 strategy",
				parameters: JSON.stringify({ hold_days: 10 }),
				status: "active" as const,
				virtualBalance: 25000,
				generation: 3,
				createdBy: "evolution",
			})
			.returning();

		const mutation: ValidatedMutation = {
			parentId: parent!.id,
			type: "parameter_tweak",
			name: "gen4-child",
			description: "Generation 4 child",
			parameters: { hold_days: 12 },
			signals: { exit: "hold_days > 12" },
			universe: ["SPY"],
			parameterDiff: { hold_days: { from: 10, to: 12 } },
		};

		const childId = await spawnChild(mutation);

		const { eq } = await import("drizzle-orm");
		const [child] = await db.select().from(strategies).where(eq(strategies.id, childId));

		expect(child!.virtualBalance).toBe(25000);
		expect(child!.generation).toBe(4); // parent gen 3 → child gen 4
	});

	it("throws when parent strategy is not found", async () => {
		const { spawnChild } = await import("../../src/evolution/spawner.ts");

		const mutation: ValidatedMutation = {
			parentId: 99999,
			type: "parameter_tweak",
			name: "orphan-child",
			description: "No parent",
			parameters: { stop_loss_pct: 3 },
			signals: {},
			universe: [],
			parameterDiff: {},
		};

		await expect(spawnChild(mutation)).rejects.toThrow("99999");
	});

	it("uses custom createdBy when provided", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { spawnChild } = await import("../../src/evolution/spawner.ts");

		const [parent] = await db
			.insert(strategies)
			.values({
				name: "parent-recovery",
				description: "Parent for recovery test",
				parameters: JSON.stringify({ stop_loss_pct: 3 }),
				signals: JSON.stringify({ entry_long: "rsi < 30" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			})
			.returning();

		const mutation: ValidatedMutation = {
			parentId: parent!.id,
			type: "structural",
			name: "recovery-strategy",
			description: "Recovery spawn",
			parameters: { stop_loss_pct: 4 },
			signals: { entry_long: "rsi < 25", exit: "rsi > 70" },
			universe: ["MSFT"],
			parameterDiff: {},
		};

		const childId = await spawnChild(mutation, "evolution:recovery");

		const { eq } = await import("drizzle-orm");
		const [child] = await db.select().from(strategies).where(eq(strategies.id, childId));

		expect(child!.createdBy).toBe("evolution:recovery");
	});
});
