import { beforeEach, describe, expect, test } from "bun:test";

describe("budget", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("getDailySpend returns 0 with no usage", async () => {
		const { getDailySpend } = await import("../../src/utils/budget.ts");
		const spend = await getDailySpend();
		expect(spend).toBe(0);
	});

	test("canAffordCall returns true when budget is 0 (unlimited)", async () => {
		const { canAffordCall } = await import("../../src/utils/budget.ts");
		const result = await canAffordCall(1.0);
		expect(result).toBe(true);
	});
});
