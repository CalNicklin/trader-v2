import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { resetConfigForTesting } from "../../src/config.ts";
import { closeDb, getDb } from "../../src/db/client.ts";
import { riskState } from "../../src/db/schema.ts";

process.env.DB_PATH = ":memory:";

describe("risk guardian PnL reading", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		resetConfigForTesting();
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});

	test("reads daily_pnl from risk_state", async () => {
		const db = getDb();
		await db.insert(riskState).values({ key: "daily_pnl", value: "-15.50" });

		const { getLivePnl } = await import("../../src/scheduler/risk-guardian-job.ts");
		const { daily } = await getLivePnl();
		expect(daily).toBeCloseTo(-15.5, 1);
	});

	test("returns 0 when no PnL recorded", async () => {
		const { getLivePnl } = await import("../../src/scheduler/risk-guardian-job.ts");
		const { daily, weekly } = await getLivePnl();
		expect(daily).toBe(0);
		expect(weekly).toBe(0);
	});
});
