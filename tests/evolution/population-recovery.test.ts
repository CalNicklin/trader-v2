import { beforeEach, describe, expect, it, mock } from "bun:test";

// Mock Anthropic SDK before any imports that use it
function buildMockProposals(parentIds: number[]) {
	return parentIds.slice(0, 3).map((parentId, i) => ({
		parentId,
		type: "structural",
		name: `recovery-mutation-${i + 1}`,
		description: `Recovery structural mutation ${i + 1}`,
		parameters: { stop_loss_pct: 3 + i, hold_days: 5 + i },
		signals: {
			entry_long: `rsi14 < ${30 - i}`,
			exit: `hold_days >= ${3 + i}`,
		},
		universe: ["AAPL", "MSFT"],
		reasoning: `Recovery reasoning ${i + 1}`,
	}));
}

let mockParentIds: number[] = [];

mock.module("@anthropic-ai/sdk", () => {
	return {
		default: class MockAnthropic {
			messages = {
				create: mock(async () => ({
					content: [
						{
							type: "text",
							text: JSON.stringify(buildMockProposals(mockParentIds)),
						},
					],
					usage: { input_tokens: 100, output_tokens: 200 },
				})),
			};
		},
	};
});

describe("population recovery mode", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { strategyMutations, strategies, strategyMetrics, tokenUsage, paperTrades, tradeInsights } =
			await import("../../src/db/schema.ts");
		await db.delete(tradeInsights);
		await db.delete(paperTrades);
		await db.delete(strategyMutations);
		await db.delete(strategyMetrics);
		await db.delete(tokenUsage);
		await db.delete(strategies);
		mockParentIds = [];
	});

	it("bypasses 30-trade gate when population is below MIN_POPULATION", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { runEvolutionCycle } = await import("../../src/evolution/index.ts");

		// Insert 2 strategies with 0 trades (below MIN_POPULATION=3)
		const inserted = await db
			.insert(strategies)
			.values([
				{
					name: "recovery-parent-1",
					description: "First strategy",
					parameters: JSON.stringify({ stop_loss_pct: 3, hold_days: 5 }),
					signals: JSON.stringify({ entry_long: "rsi14 < 30", exit: "hold_days >= 3" }),
					universe: JSON.stringify(["AAPL", "MSFT"]),
					status: "paper" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
				},
				{
					name: "recovery-parent-2",
					description: "Second strategy",
					parameters: JSON.stringify({ stop_loss_pct: 4, hold_days: 7 }),
					signals: JSON.stringify({ entry_long: "rsi14 < 25", exit: "hold_days >= 5" }),
					universe: JSON.stringify(["AAPL", "MSFT"]),
					status: "paper" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
				},
			])
			.returning();

		mockParentIds = inserted.map((s) => s.id);

		const result = await runEvolutionCycle();

		// Should NOT have been skipped — recovery mode bypasses 30-trade gate
		expect(result.skippedReason).toBeUndefined();
		expect(result.spawned.length).toBeGreaterThan(0);
	});

	it("caps recovery spawns at RECOVERY_SPAWN_CAP (2)", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { runEvolutionCycle } = await import("../../src/evolution/index.ts");

		// Insert 1 strategy (below MIN_POPULATION=3)
		const inserted = await db
			.insert(strategies)
			.values({
				name: "lone-strategy",
				description: "Only strategy",
				parameters: JSON.stringify({ stop_loss_pct: 3, hold_days: 5 }),
				signals: JSON.stringify({ entry_long: "rsi14 < 30", exit: "hold_days >= 3" }),
				universe: JSON.stringify(["AAPL", "MSFT"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			})
			.returning();

		// Mock returns 3 proposals all with same parentId
		mockParentIds = [inserted[0]!.id, inserted[0]!.id, inserted[0]!.id];

		const result = await runEvolutionCycle();

		// Recovery cap is 2, so even though 3 proposals returned, only 2 should spawn
		expect(result.spawned.length).toBeLessThanOrEqual(2);
		expect(result.skippedReason).toBeUndefined();
	});

	it("tags recovery spawns with createdBy 'evolution:recovery'", async () => {
		const { strategies: strategiesTable } = await import("../../src/db/schema.ts");
		const { runEvolutionCycle } = await import("../../src/evolution/index.ts");
		const { eq } = await import("drizzle-orm");

		// Insert 2 strategies (below MIN_POPULATION=3)
		const inserted = await db
			.insert(strategiesTable)
			.values([
				{
					name: "tag-parent-1",
					description: "Parent 1",
					parameters: JSON.stringify({ stop_loss_pct: 3, hold_days: 5 }),
					signals: JSON.stringify({ entry_long: "rsi14 < 30", exit: "hold_days >= 3" }),
					universe: JSON.stringify(["AAPL", "MSFT"]),
					status: "paper" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
				},
				{
					name: "tag-parent-2",
					description: "Parent 2",
					parameters: JSON.stringify({ stop_loss_pct: 4, hold_days: 7 }),
					signals: JSON.stringify({ entry_long: "rsi14 < 25", exit: "hold_days >= 5" }),
					universe: JSON.stringify(["AAPL", "MSFT"]),
					status: "paper" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
				},
			])
			.returning();

		mockParentIds = inserted.map((s) => s.id);

		const result = await runEvolutionCycle();

		// Check spawned strategies have createdBy = "evolution:recovery"
		for (const childId of result.spawned) {
			const [child] = await db
				.select()
				.from(strategiesTable)
				.where(eq(strategiesTable.id, childId));
			expect(child!.createdBy).toBe("evolution:recovery");
		}
	});

	it("still skips when population is at or above MIN_POPULATION with no 30-trade strategies", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { runEvolutionCycle } = await import("../../src/evolution/index.ts");

		// Insert 3 strategies with 0 trades (at MIN_POPULATION=3, NOT in recovery)
		await db.insert(strategies).values([
			{
				name: "normal-1",
				description: "Strategy 1",
				parameters: JSON.stringify({ stop_loss_pct: 3 }),
				signals: JSON.stringify({ entry_long: "rsi14 < 30", exit: "hold_days >= 3" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			},
			{
				name: "normal-2",
				description: "Strategy 2",
				parameters: JSON.stringify({ stop_loss_pct: 4 }),
				signals: JSON.stringify({ entry_long: "rsi14 < 25", exit: "hold_days >= 5" }),
				universe: JSON.stringify(["MSFT"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			},
			{
				name: "normal-3",
				description: "Strategy 3",
				parameters: JSON.stringify({ stop_loss_pct: 5 }),
				signals: JSON.stringify({ entry_long: "rsi14 < 20", exit: "hold_days >= 7" }),
				universe: JSON.stringify(["GOOGL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			},
		]);

		const result = await runEvolutionCycle();

		// Not in recovery mode, no strategies with 30+ trades → should skip
		expect(result.skippedReason).toBe("no paper strategies with 30+ trades");
		expect(result.spawned).toEqual([]);
	});
});
