import { beforeEach, describe, expect, test } from "bun:test";

describe("runDailyDeltaCheck", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("demotes symbols flagged as halted by the checker", async () => {
		const { runDailyDeltaCheck } = await import("../../src/universe/delta.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await getDb()
			.insert(investableUniverse)
			.values({
				symbol: "HALT",
				exchange: "NASDAQ",
				indexSource: "russell_1000" as const,
				active: true,
			});

		const result = await runDailyDeltaCheck({
			checker: async () => [{ symbol: "HALT", exchange: "NASDAQ", reason: "halted" }],
			snapshotDate: "2026-04-17",
		});

		expect(result.demoted).toBe(1);
		const rows = await getDb()
			.select()
			.from(investableUniverse)
			.where(eq(investableUniverse.symbol, "HALT"))
			.all();
		expect(rows[0]?.active).toBe(false);
	});

	test("does nothing when no symbols are flagged", async () => {
		const { runDailyDeltaCheck } = await import("../../src/universe/delta.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");

		await getDb()
			.insert(investableUniverse)
			.values({
				symbol: "OK",
				exchange: "NASDAQ",
				indexSource: "russell_1000" as const,
				active: true,
			});

		const result = await runDailyDeltaCheck({
			checker: async () => [],
			snapshotDate: "2026-04-17",
		});

		expect(result.demoted).toBe(0);
	});

	test("respects exemptSymbols (open positions stay active)", async () => {
		const { runDailyDeltaCheck } = await import("../../src/universe/delta.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await getDb()
			.insert(investableUniverse)
			.values({
				symbol: "HOLD",
				exchange: "NASDAQ",
				indexSource: "russell_1000" as const,
				active: true,
			});

		await runDailyDeltaCheck({
			checker: async () => [{ symbol: "HOLD", exchange: "NASDAQ", reason: "halted" }],
			snapshotDate: "2026-04-17",
			exemptSymbols: ["HOLD:NASDAQ"],
		});

		const rows = await getDb()
			.select()
			.from(investableUniverse)
			.where(eq(investableUniverse.symbol, "HOLD"))
			.all();
		expect(rows[0]?.active).toBe(true);
	});
});
