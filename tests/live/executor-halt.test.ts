import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { resetConfigForTesting } from "../../src/config.ts";
import { closeDb, getDb } from "../../src/db/client.ts";
import { isTradingHalted, isWeeklyDrawdownActive } from "../../src/risk/guardian.ts";

process.env.DB_PATH = ":memory:";

describe("trading halt checks (integration)", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		resetConfigForTesting();
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});

	test("isTradingHalted returns false when no flags set", async () => {
		const result = await isTradingHalted();
		expect(result.halted).toBe(false);
	});

	test("isWeeklyDrawdownActive returns false by default", async () => {
		const result = await isWeeklyDrawdownActive();
		expect(result).toBe(false);
	});
});
