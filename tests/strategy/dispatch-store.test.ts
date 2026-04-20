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

	test("writeScheduledDecisions inserts rows with source=scheduled", async () => {
		const { writeScheduledDecisions } = await import(
			"../../src/strategy/dispatch-store.ts"
		);
		const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
		await writeScheduledDecisions(
			[
				{ strategyId: 1, symbol: "AAPL", action: "activate", reasoning: "x" },
				{ strategyId: 1, symbol: "MSFT", action: "skip", reasoning: "y" },
			],
			expiresAt,
		);
		const rows = await getActiveDecisions();
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.source === "scheduled")).toBe(true);
	});

	test("writeScheduledDecisions with empty array is a no-op", async () => {
		const { writeScheduledDecisions } = await import(
			"../../src/strategy/dispatch-store.ts"
		);
		await writeScheduledDecisions([], new Date(Date.now() + 60_000).toISOString());
		const rows = await getActiveDecisions();
		expect(rows).toEqual([]);
	});

	test("writeCatalystDecisions inserts rows with source=catalyst and news event id", async () => {
		const { writeCatalystDecisions } = await import(
			"../../src/strategy/dispatch-store.ts"
		);
		const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
		await writeCatalystDecisions(
			[{ strategyId: 1, symbol: "AAPL", action: "activate", reasoning: "x" }],
			expiresAt,
			42,
		);
		const rows = await getActiveDecisions();
		expect(rows.length).toBe(1);
		expect(rows[0]!.source).toBe("catalyst");
		expect(rows[0]!.sourceNewsEventId).toBe(42);
	});

	test("expireScheduledDecisions expires scheduled rows but leaves catalyst rows untouched", async () => {
		const { writeScheduledDecisions, writeCatalystDecisions, expireScheduledDecisions } =
			await import("../../src/strategy/dispatch-store.ts");
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		await writeScheduledDecisions(
			[{ strategyId: 1, symbol: "AAPL", action: "activate", reasoning: "sched" }],
			expiresAt,
		);
		await writeCatalystDecisions(
			[{ strategyId: 2, symbol: "AAPL", action: "activate", reasoning: "cat" }],
			expiresAt,
			1,
		);
		await expireScheduledDecisions();
		const rows = await getActiveDecisions();
		expect(rows.length).toBe(1);
		expect(rows[0]!.source).toBe("catalyst");
	});

	test("cleanupExpiredDecisions deletes rows with expires_at older than 24h ago", async () => {
		const db = getDb();
		const { cleanupExpiredDecisions } = await import(
			"../../src/strategy/dispatch-store.ts"
		);
		const veryOld = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		const recentExpired = new Date(Date.now() - 60 * 1000).toISOString();
		await db.insert(dispatchDecisions).values([
			{
				strategyId: 1,
				symbol: "AAPL",
				action: "skip",
				reasoning: "old",
				source: "scheduled",
				expiresAt: veryOld,
			},
			{
				strategyId: 2,
				symbol: "AAPL",
				action: "skip",
				reasoning: "recent",
				source: "scheduled",
				expiresAt: recentExpired,
			},
		]);
		const deleted = await cleanupExpiredDecisions();
		expect(deleted).toBe(1);
		const remaining = await db.select().from(dispatchDecisions);
		expect(remaining.length).toBe(1);
		expect(remaining[0]!.reasoning).toBe("recent");
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
