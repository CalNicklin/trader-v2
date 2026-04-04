import { beforeEach, describe, expect, test } from "bun:test";

describe("meta-evolution", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { tradeInsights, learningLoopConfig } = await import("../../src/db/schema.ts");
		await db.delete(tradeInsights);
		await db.delete(learningLoopConfig);
	});

	test("computeHitRates returns 0 when no insights exist", async () => {
		const { computeHitRates } = await import("../../src/learning/meta-evolution.ts");

		const rates = await computeHitRates();
		expect(rates.trade_review).toBe(0);
		expect(rates.pattern_analysis).toBe(0);
	});

	test("computeHitRates returns correct rate when insights exist", async () => {
		const { tradeInsights } = await import("../../src/db/schema.ts");
		const { computeHitRates } = await import("../../src/learning/meta-evolution.ts");

		// 3 insights, 1 led to improvement
		await db.insert(tradeInsights).values([
			{
				strategyId: 1,
				insightType: "trade_review" as const,
				tags: "[]",
				observation: "test 1",
				ledToImprovement: true,
			},
			{
				strategyId: 1,
				insightType: "trade_review" as const,
				tags: "[]",
				observation: "test 2",
				ledToImprovement: false,
			},
			{
				strategyId: 1,
				insightType: "trade_review" as const,
				tags: "[]",
				observation: "test 3",
				ledToImprovement: false,
			},
		]);

		const rates = await computeHitRates();
		expect(rates.trade_review).toBeCloseTo(1 / 3, 2);
	});

	test("updatePromptHitRate writes hit rate to config row", async () => {
		const { learningLoopConfig } = await import("../../src/db/schema.ts");
		const { updatePromptHitRate } = await import("../../src/learning/meta-evolution.ts");

		await db.insert(learningLoopConfig).values({
			configType: "trade_review" as const,
			promptVersion: 1,
			promptText: "test prompt",
			active: true,
		});

		await updatePromptHitRate("trade_review", 0.33);

		const rows = await db.select().from(learningLoopConfig);
		expect(rows[0]!.hitRate).toBeCloseTo(0.33, 2);
	});
});
