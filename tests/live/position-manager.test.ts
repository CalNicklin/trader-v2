import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { resetConfigForTesting } from "../../src/config.ts";
import { closeDb, getDb } from "../../src/db/client.ts";
import { livePositions } from "../../src/db/schema.ts";

// Set up in-memory DB
process.env.DB_PATH = ":memory:";

describe("position manager", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		resetConfigForTesting();
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});

	test("onEntryFill creates livePositions row", async () => {
		const { onEntryFill } = await import("../../src/live/position-manager.ts");
		const db = getDb();

		await onEntryFill({
			symbol: "AAPL",
			exchange: "NASDAQ",
			strategyId: 1,
			quantity: 10,
			avgCost: 150.0,
			stopLossPrice: 143.0,
			side: "BUY",
		});

		const positions = await db.select().from(livePositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.symbol).toBe("AAPL");
		expect(positions[0]!.quantity).toBe(10);
		expect(positions[0]!.stopLossPrice).toBe(143.0);
	});

	test("onExitFill computes PnL and deletes position", async () => {
		const { onEntryFill, onExitFill } = await import("../../src/live/position-manager.ts");
		const db = getDb();

		await onEntryFill({
			symbol: "AAPL",
			exchange: "NASDAQ",
			strategyId: 1,
			quantity: 10,
			avgCost: 150.0,
			stopLossPrice: 143.0,
			side: "BUY",
		});

		const pnl = await onExitFill({
			symbol: "AAPL",
			exchange: "NASDAQ",
			exitPrice: 160.0,
			quantity: 10,
			commission: 1.0,
		});

		expect(pnl).toBeCloseTo(99.0, 0); // (160-150)*10 - 1.0

		const positions = await db.select().from(livePositions);
		expect(positions).toHaveLength(0);
	});

	test("onExitFill computes PnL for short position", async () => {
		const { onEntryFill, onExitFill } = await import("../../src/live/position-manager.ts");

		await onEntryFill({
			symbol: "TSLA",
			exchange: "NASDAQ",
			strategyId: 1,
			quantity: -5, // short
			avgCost: 200.0,
			stopLossPrice: 210.0,
			side: "SELL",
		});

		const pnl = await onExitFill({
			symbol: "TSLA",
			exchange: "NASDAQ",
			exitPrice: 180.0,
			quantity: 5,
			commission: 1.0,
		});

		// Short PnL: (entry - exit) * qty - commission = (200-180)*5 - 1 = 99
		expect(pnl).toBeCloseTo(99.0, 0);
	});
});
