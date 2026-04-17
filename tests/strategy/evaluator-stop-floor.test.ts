import { beforeEach, describe, expect, test } from "bun:test";
import type { QuoteFields } from "../../src/strategy/context.ts";
import type { SymbolIndicators } from "../../src/strategy/historical.ts";

const VALID_INDICATORS: SymbolIndicators = { rsi14: 45, atr14: 3.0, volume_ratio: 1.5 };

function makeQuote(last: number): QuoteFields {
	return {
		last,
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
	};
}

describe("evaluator hard stop-loss kill floor", () => {
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

	// ── BUY position tests ────────────────────────────────────────────────────

	test("kills BUY position at exactly -5% loss", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "kill_floor_buy_exact",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10, stop_loss_pct: 5 }),
				signals: JSON.stringify({
					entry_long: "last > 0",
					// exit only fires at 100% gain — will never fire in this test
					exit: "pnl_pct > 100",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Entry at 100; -5% would be 95
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 100,
			quantity: 10,
			signalType: "entry_long",
			reasoning: "test",
		});

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: makeQuote(95), // exactly -5%
			indicators: VALID_INDICATORS,
		});

		expect(result.kind).toBe("exited");

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.closedAt).not.toBeNull();

		const trades = await db.select().from(paperTrades);
		const exitTrade = trades.find((t) => t.signalType === "hard_stop");
		expect(exitTrade).toBeDefined();
		expect(exitTrade!.price).toBe(95);
	});

	test("kills BUY position below -5% loss (worse than floor)", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "kill_floor_buy_worse",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10, stop_loss_pct: 5 }),
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

		// Entry at 100; -7% = 93
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 100,
			quantity: 10,
			signalType: "entry_long",
			reasoning: "test",
		});

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: makeQuote(93), // -7%
			indicators: VALID_INDICATORS,
		});

		expect(result.kind).toBe("exited");

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.closedAt).not.toBeNull();

		const trades = await db.select().from(paperTrades);
		const exitTrade = trades.find((t) => t.signalType === "hard_stop");
		expect(exitTrade).toBeDefined();
	});

	test("does NOT kill BUY position at -4.9% (below floor threshold)", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "kill_floor_buy_no_kill",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10, stop_loss_pct: 5 }),
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

		// Entry at 100; -4.9% = 95.1
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 100,
			quantity: 10,
			signalType: "entry_long",
			reasoning: "test",
		});

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: makeQuote(95.1), // -4.9% — just under floor
			indicators: VALID_INDICATORS,
		});

		// Should return "none" — normal exit signal didn't fire, floor didn't trigger
		expect(result.kind).toBe("none");

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.closedAt).toBeNull();
	});

	// ── SELL position tests ───────────────────────────────────────────────────

	test("kills SELL position at exactly -5% loss (price risen 5%)", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "kill_floor_sell_exact",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10, stop_loss_pct: 5 }),
				signals: JSON.stringify({
					entry_short: "last > 0",
					exit: "pnl_pct > 100",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Entry (short) at 100; price rises to 105 (+5%) = -5% loss for short
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "SELL",
			price: 100,
			quantity: 10,
			signalType: "entry_short",
			reasoning: "test",
		});

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: makeQuote(105), // +5% from entry = -5% on short
			indicators: VALID_INDICATORS,
		});

		expect(result.kind).toBe("exited");

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.closedAt).not.toBeNull();

		const trades = await db.select().from(paperTrades);
		const exitTrade = trades.find((t) => t.signalType === "hard_stop");
		expect(exitTrade).toBeDefined();
		expect(exitTrade!.price).toBe(105);
	});

	test("does NOT kill SELL position at -4.9% loss (below floor threshold)", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "kill_floor_sell_no_kill",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10, stop_loss_pct: 5 }),
				signals: JSON.stringify({
					entry_short: "last > 0",
					exit: "pnl_pct > 100",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Entry (short) at 100; price rises to 104.9 (+4.9%) = -4.9% on short
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "SELL",
			price: 100,
			quantity: 10,
			signalType: "entry_short",
			reasoning: "test",
		});

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: makeQuote(104.9), // +4.9% from entry = -4.9% on short — under floor
			indicators: VALID_INDICATORS,
		});

		expect(result.kind).toBe("none");

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.closedAt).toBeNull();
	});

	// ── Null quote guard ──────────────────────────────────────────────────────

	test("does NOT trigger kill floor when quote.last is null", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "kill_floor_null_quote",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10, stop_loss_pct: 5 }),
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

		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 100,
			quantity: 10,
			signalType: "entry_long",
			reasoning: "test",
		});

		const nullQuote: QuoteFields = {
			last: null,
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
		};

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: nullQuote,
			indicators: VALID_INDICATORS,
		});

		// null quote → kill floor skipped, normal exit didn't fire
		expect(result.kind).toBe("none");

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.closedAt).toBeNull();
	});

	// ── hard_stop puts symbol on re-entry cooldown ───────────────────────────

	test("hard_stop exit places symbol on cooldown (prevents immediate re-entry)", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const { openPaperPosition, getSymbolsOnCooldown } = await import(
			"../../src/paper/manager.ts"
		);

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "kill_floor_cooldown",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10, stop_loss_pct: 5 }),
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

		// Entry at 100; drop to 90 (-10%) triggers hard_stop
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 100,
			quantity: 10,
			signalType: "entry_long",
			reasoning: "test",
		});

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: makeQuote(90), // -10% — triggers hard_stop
			indicators: VALID_INDICATORS,
		});

		expect(result.kind).toBe("exited");

		// Symbol must now appear in the cooldown set
		const cooldown = await getSymbolsOnCooldown(strat!.id);
		expect(cooldown.has("AAPL:NASDAQ")).toBe(true);
	});

	// ── entryPrice = 0 guard ─────────────────────────────────────────────────

	test("does NOT crash or trigger kill floor when entryPrice is 0", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions } = await import("../../src/db/schema.ts");

		// Insert an open position with entryPrice 0 directly into the DB
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "kill_floor_zero_entry",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10, stop_loss_pct: 5 }),
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

		// Insert the position manually with entryPrice = 0
		await db.insert(paperPositions).values({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			entryPrice: 0,
			quantity: 10,
			openedAt: new Date().toISOString(),
		});

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: makeQuote(50), // any price — entryPrice=0 guard should skip kill floor
			indicators: VALID_INDICATORS,
		});

		// No crash, and no false kill-floor trigger — exit signal didn't fire (pnl_pct > 100 is false)
		expect(result.kind).toBe("none");
	});

	// ── Kill floor fires BEFORE exit signal ──────────────────────────────────

	test("kill floor fires before normal exit signal when both conditions met", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "kill_floor_priority",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10, stop_loss_pct: 5 }),
				signals: JSON.stringify({
					entry_long: "last > 0",
					// exit fires on any live quote (hold_days >= 0)
					exit: "hold_days >= 0",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Entry at 100; price drops to 90 (-10%) — both exit signal and kill floor would fire
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 100,
			quantity: 10,
			signalType: "entry_long",
			reasoning: "test",
		});

		await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: makeQuote(90), // -10%
			indicators: VALID_INDICATORS,
		});

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.closedAt).not.toBeNull();

		// The exit trade must be hard_stop, not "exit" (kill floor fires first)
		const trades = await db.select().from(paperTrades);
		const exitTrades = trades.filter((t) => t.signalType !== "entry_long");
		expect(exitTrades).toHaveLength(1);
		expect(exitTrades[0]!.signalType).toBe("hard_stop");
	});
});
