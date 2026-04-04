import { beforeEach, describe, expect, test } from "bun:test";

describe("learning loop prompts", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { learningLoopConfig } = await import("../../src/db/schema.ts");
		await db.delete(learningLoopConfig);
	});

	test("getActivePrompt returns default when no DB entry exists", async () => {
		const { getActivePrompt } = await import("../../src/learning/prompts.ts");

		const prompt = await getActivePrompt("trade_review");
		expect(prompt.promptText).toContain("financial trade reviewer");
		expect(prompt.promptVersion).toBe(0);
	});

	test("getActivePrompt returns DB entry when one exists", async () => {
		const { learningLoopConfig } = await import("../../src/db/schema.ts");
		const { getActivePrompt } = await import("../../src/learning/prompts.ts");

		await db.insert(learningLoopConfig).values({
			configType: "trade_review",
			promptVersion: 2,
			promptText: "Custom prompt v2",
			active: true,
		});

		const prompt = await getActivePrompt("trade_review");
		expect(prompt.promptText).toBe("Custom prompt v2");
		expect(prompt.promptVersion).toBe(2);
	});

	test("getActivePrompt ignores inactive entries", async () => {
		const { learningLoopConfig } = await import("../../src/db/schema.ts");
		const { getActivePrompt } = await import("../../src/learning/prompts.ts");

		await db.insert(learningLoopConfig).values({
			configType: "trade_review",
			promptVersion: 3,
			promptText: "Retired prompt",
			active: false,
			retiredAt: new Date().toISOString(),
		});

		const prompt = await getActivePrompt("trade_review");
		expect(prompt.promptVersion).toBe(0); // falls back to default
	});

	test("DEFAULT_PROMPTS has entries for all three config types", async () => {
		const { DEFAULT_PROMPTS } = await import("../../src/learning/prompts.ts");

		expect(DEFAULT_PROMPTS.trade_review).toBeDefined();
		expect(DEFAULT_PROMPTS.pattern_analysis).toBeDefined();
		expect(DEFAULT_PROMPTS.graduation).toBeDefined();
	});
});
