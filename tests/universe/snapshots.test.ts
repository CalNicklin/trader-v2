import { beforeEach, describe, expect, test } from "bun:test";

describe("writeDailySnapshot", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("records an added row when symbol is new in current membership", async () => {
		const { writeDailySnapshot } = await import("../../src/universe/snapshots.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { universeSnapshots } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await writeDailySnapshot("2026-04-17", {
			current: [{ symbol: "AAPL", exchange: "NASDAQ" }],
			previous: [],
		});

		const rows = await getDb()
			.select()
			.from(universeSnapshots)
			.where(eq(universeSnapshots.snapshotDate, "2026-04-17"))
			.all();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.action).toBe("added");
		expect(rows[0]?.symbol).toBe("AAPL");
	});

	test("records a removed row when symbol exits membership", async () => {
		const { writeDailySnapshot } = await import("../../src/universe/snapshots.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { universeSnapshots } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await writeDailySnapshot("2026-04-17", {
			current: [],
			previous: [{ symbol: "MSFT", exchange: "NASDAQ" }],
			removalReasons: { "MSFT:NASDAQ": "halted" },
		});

		const rows = await getDb()
			.select()
			.from(universeSnapshots)
			.where(eq(universeSnapshots.snapshotDate, "2026-04-17"))
			.all();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.action).toBe("removed");
		expect(rows[0]?.reason).toBe("halted");
	});

	test("writes nothing for unchanged membership", async () => {
		const { writeDailySnapshot } = await import("../../src/universe/snapshots.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { universeSnapshots } = await import("../../src/db/schema.ts");

		await writeDailySnapshot("2026-04-17", {
			current: [{ symbol: "AAPL", exchange: "NASDAQ" }],
			previous: [{ symbol: "AAPL", exchange: "NASDAQ" }],
		});

		const rows = await getDb().select().from(universeSnapshots).all();
		expect(rows).toHaveLength(0);
	});
});
