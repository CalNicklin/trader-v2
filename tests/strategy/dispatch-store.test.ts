import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { resetConfigForTesting } from "../../src/config.ts";
import { closeDb, getDb } from "../../src/db/client.ts";
import { dispatchDecisions } from "../../src/db/schema.ts";
import { getActiveDecisions } from "../../src/strategy/dispatch-store.ts";

describe("dispatch-store", () => {
	beforeEach(async () => {
		closeDb();
		resetConfigForTesting();
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		await db.delete(dispatchDecisions);
	});

	afterEach(async () => {
		const db = getDb();
		await db.delete(dispatchDecisions);
	});

	test("returns empty array when table is empty", async () => {
		const result = await getActiveDecisions();
		expect(result).toEqual([]);
	});

	test("returns scheduled decisions that haven't expired", async () => {
		const db = getDb();
		const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		await db.insert(dispatchDecisions).values({
			strategyId: 1,
			symbol: "AAPL",
			action: "activate",
			reasoning: "test",
			source: "scheduled",
			expiresAt: futureExpiry,
		});
		const result = await getActiveDecisions();
		expect(result.length).toBe(1);
		expect(result[0]!.strategyId).toBe(1);
		expect(result[0]!.symbol).toBe("AAPL");
		expect(result[0]!.action).toBe("activate");
	});

	test("filters out expired decisions", async () => {
		const db = getDb();
		const pastExpiry = new Date(Date.now() - 60 * 1000).toISOString();
		await db.insert(dispatchDecisions).values({
			strategyId: 1,
			symbol: "AAPL",
			action: "activate",
			reasoning: "test",
			source: "scheduled",
			expiresAt: pastExpiry,
		});
		const result = await getActiveDecisions();
		expect(result).toEqual([]);
	});

	test("catalyst row wins over scheduled row for same (strategy, symbol)", async () => {
		const db = getDb();
		const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		await db.insert(dispatchDecisions).values([
			{
				strategyId: 1,
				symbol: "AAPL",
				action: "skip",
				reasoning: "scheduled skip",
				source: "scheduled",
				expiresAt: futureExpiry,
			},
			{
				strategyId: 1,
				symbol: "AAPL",
				action: "activate",
				reasoning: "catalyst activate",
				source: "catalyst",
				expiresAt: futureExpiry,
			},
		]);
		const result = await getActiveDecisions();
		expect(result.length).toBe(1);
		expect(result[0]!.action).toBe("activate");
		expect(result[0]!.reasoning).toBe("catalyst activate");
	});

	test("among multiple catalyst rows for same pair, newest createdAt wins", async () => {
		const db = getDb();
		const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const older = new Date(Date.now() - 60 * 1000).toISOString();
		const newer = new Date(Date.now() - 1000).toISOString();
		await db.insert(dispatchDecisions).values([
			{
				strategyId: 1,
				symbol: "AAPL",
				action: "skip",
				reasoning: "older catalyst",
				source: "catalyst",
				createdAt: older,
				expiresAt: futureExpiry,
			},
			{
				strategyId: 1,
				symbol: "AAPL",
				action: "activate",
				reasoning: "newer catalyst",
				source: "catalyst",
				createdAt: newer,
				expiresAt: futureExpiry,
			},
		]);
		const result = await getActiveDecisions();
		expect(result.length).toBe(1);
		expect(result[0]!.reasoning).toBe("newer catalyst");
	});

	test("returns separate rows for different (strategy, symbol) pairs", async () => {
		const db = getDb();
		const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		await db.insert(dispatchDecisions).values([
			{
				strategyId: 1,
				symbol: "AAPL",
				action: "activate",
				reasoning: "a",
				source: "scheduled",
				expiresAt: futureExpiry,
			},
			{
				strategyId: 2,
				symbol: "AAPL",
				action: "skip",
				reasoning: "b",
				source: "scheduled",
				expiresAt: futureExpiry,
			},
			{
				strategyId: 1,
				symbol: "MSFT",
				action: "activate",
				reasoning: "c",
				source: "scheduled",
				expiresAt: futureExpiry,
			},
		]);
		const result = await getActiveDecisions();
		expect(result.length).toBe(3);
	});
});
