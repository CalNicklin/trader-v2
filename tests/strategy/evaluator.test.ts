import { beforeEach, describe, expect, test } from "bun:test";
import type { QuoteFields } from "../../src/strategy/context.ts";
import type { SymbolIndicators } from "../../src/strategy/historical.ts";

const VALID_QUOTE: QuoteFields = {
	last: 150,
	bid: 149.5,
	ask: 150.5,
	volume: 5000000,
	avgVolume: 3000000,
	changePercent: 1.0,
	newsSentiment: null,
	newsEarningsSurprise: null,
	newsGuidanceChange: null,
	newsManagementTone: null,
	newsRegulatoryRisk: null,
	newsAcquisitionLikelihood: null,
	newsCatalystType: null,
	newsExpectedMoveDuration: null,
};

const VALID_INDICATORS: SymbolIndicators = { rsi14: 45, atr14: 3.0, volume_ratio: 1.5 };

describe("strategy evaluator", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("evaluateStrategyForSymbol returns proposedEntry when entry signal fires", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_long",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "last > 0",
					exit: "pnl_pct > 100",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: {
				last: 150,
				bid: 149.5,
				ask: 150.5,
				volume: 5000000,
				avgVolume: 3000000,
				changePercent: 1.0,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: 45, atr14: 3.0, volume_ratio: 1.5 },
		});

		expect(result.kind).toBe("proposedEntry");
		if (result.kind === "proposedEntry") {
			expect(result.params.symbol).toBe("AAPL");
			expect(result.params.side).toBe("BUY");
			expect(result.params.strategyId).toBe(strat!.id);
		}
	});

	test("evaluateStrategy closes position when exit signal fires", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_exit",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "rsi14 < 20",
					exit: "hold_days >= 0",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "test",
		});

		await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: {
				last: 160,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: 55, atr14: 3.0, volume_ratio: 1.0 },
		});

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.closedAt).not.toBeNull();

		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(2);
	});

	test("evaluateStrategy does nothing when no signal fires", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_no_signal",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "rsi14 < 10",
					exit: "pnl_pct > 100",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: {
				last: 150,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: 50, atr14: 3.0, volume_ratio: 1.0 },
		});

		const positions = await db.select().from(paperPositions);
		expect(positions).toHaveLength(0);
	});

	test("evaluateAllStrategies exits orphaned positions not in current universe", async () => {
		const { evaluateAllStrategies } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		// Strategy universe only contains AAPL, but position is on MSFT
		// Entry signal requires rsi14 < 10 so it won't trigger on AAPL
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_orphan",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "rsi14 < 10",
					exit: "hold_days >= 1",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Open a position on MSFT (not in universe) with old openedAt
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "MSFT",
			exchange: "NASDAQ",
			side: "BUY",
			price: 370,
			quantity: 5,
			signalType: "entry_long",
			reasoning: "test",
		});

		// Backdate the position so hold_days >= 1
		await db
			.update(paperPositions)
			.set({ openedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() });

		// Provide quote data for MSFT when requested
		await evaluateAllStrategies(async (symbol, _exchange) => {
			if (symbol === "MSFT" || symbol === "AAPL") {
				return { quote: { ...VALID_QUOTE, last: 375 }, indicators: VALID_INDICATORS };
			}
			return null;
		});

		// The orphaned MSFT position should be closed
		const positions = await db.select().from(paperPositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.closedAt).not.toBeNull();

		// Should have entry + exit trade
		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(2);
		expect(trades[1]!.signalType).toBe("exit");
	});

	test("evaluateAllStrategies uses time-based exit when quote data is null", async () => {
		const { evaluateAllStrategies } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_null_quote",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "last > 0",
					exit: "hold_days >= 1 OR pnl_pct > 5",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "test",
		});

		// Backdate the position so hold_days >= 1
		await db
			.update(paperPositions)
			.set({ openedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() });

		// Return null for all quotes (simulating quote cache failure)
		await evaluateAllStrategies(async () => null);

		// Position should still be closed via time-based exit
		const positions = await db.select().from(paperPositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.closedAt).not.toBeNull();

		// Exit trade should use entry price as fallback
		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(2);
		const exitTrade = trades[1]!;
		expect(exitTrade.signalType).toBe("exit");
		expect(exitTrade.price).toBe(150); // falls back to entry price
		expect(exitTrade.reasoning).toContain("Time-based exit");
	});

	test("evaluateAllStrategies does not exit orphaned position when hold_days is insufficient", async () => {
		const { evaluateAllStrategies } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_no_exit",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "last > 0",
					exit: "hold_days >= 5",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Open a position on MSFT (orphaned) with recent openedAt (hold_days < 5)
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "MSFT",
			exchange: "NASDAQ",
			side: "BUY",
			price: 370,
			quantity: 5,
			signalType: "entry_long",
			reasoning: "test",
		});

		// No quote data available — but hold_days is only ~0, which is < 5
		await evaluateAllStrategies(async () => null);

		// Position should remain open
		const positions = await db.select().from(paperPositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.closedAt).toBeNull();
	});
});
