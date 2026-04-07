import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { resetConfigForTesting } from "../../src/config";
import { closeDb, getDb } from "../../src/db/client";
import { strategies } from "../../src/db/schema";

describe("evaluator exchange filtering", () => {
	beforeEach(async () => {
		closeDb();
		resetConfigForTesting();
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("evaluateAllStrategies filters universe by exchanges when provided", async () => {
		const db = getDb();
		await db.insert(strategies).values({
			name: "mixed_strat",
			description: "test",
			parameters: JSON.stringify({ threshold: 0.5 }),
			signals: JSON.stringify({ entry_long: "last > 0", exit: "hold_days >= 1" }),
			universe: JSON.stringify(["AAPL:NASDAQ", "VOD:LSE"]),
			status: "paper",
			virtualBalance: 10000,
			generation: 1,
		});

		const requestedSymbols: string[] = [];
		const { evaluateAllStrategies } = await import("../../src/strategy/evaluator");
		await evaluateAllStrategies(
			async (symbol, _exchange) => {
				requestedSymbols.push(symbol);
				return null;
			},
			{ exchanges: ["NASDAQ", "NYSE"] },
		);

		expect(requestedSymbols).toContain("AAPL");
		expect(requestedSymbols).not.toContain("VOD");
	});

	test("evaluateAllStrategies does not filter when no exchanges given", async () => {
		const db = getDb();
		await db.insert(strategies).values({
			name: "mixed_strat",
			description: "test",
			parameters: JSON.stringify({ threshold: 0.5 }),
			signals: JSON.stringify({ entry_long: "last > 0", exit: "hold_days >= 1" }),
			universe: JSON.stringify(["AAPL:NASDAQ", "VOD:LSE"]),
			status: "paper",
			virtualBalance: 10000,
			generation: 1,
		});

		const requestedSymbols: string[] = [];
		const { evaluateAllStrategies } = await import("../../src/strategy/evaluator");
		await evaluateAllStrategies(async (symbol, _exchange) => {
			requestedSymbols.push(symbol);
			return null;
		});

		expect(requestedSymbols).toContain("AAPL");
		expect(requestedSymbols).toContain("VOD");
	});
});
