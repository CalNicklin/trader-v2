import { beforeEach, describe, expect, test } from "bun:test";
import type { QuoteFields } from "../../src/strategy/context.ts";
import type { SymbolIndicators } from "../../src/strategy/historical.ts";

const VALID_QUOTE: QuoteFields = {
	last: 150,
	bid: 149.5,
	ask: 150.5,
	volume: 5_000_000,
	avgVolume: 3_000_000,
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

describe("evaluator — TRA-6 slippage wiring", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		process.env.PAPER_SLIPPAGE_BPS = "5";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("entry_long proposal carries slipped-up fill price (BUY pays more)", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "slippage_long",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({ entry_long: "last > 0", exit: "pnl_pct > 100" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10_000,
				generation: 1,
			})
			.returning();

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: VALID_QUOTE,
			indicators: VALID_INDICATORS,
		});

		expect(result.kind).toBe("proposedEntry");
		if (result.kind === "proposedEntry") {
			// 150 * (1 + 5/10000) = 150.075
			expect(result.params.price).toBeCloseTo(150.075, 5);
			expect(result.params.side).toBe("BUY");
		}
	});

	test("entry_short proposal carries slipped-down fill price (SELL receives less)", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "slippage_short",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({ entry_short: "last > 0", exit: "pnl_pct > 100" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10_000,
				generation: 1,
			})
			.returning();

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: VALID_QUOTE,
			indicators: VALID_INDICATORS,
		});

		expect(result.kind).toBe("proposedEntry");
		if (result.kind === "proposedEntry") {
			// 150 * (1 - 5/10000) = 149.925
			expect(result.params.price).toBeCloseTo(149.925, 5);
			expect(result.params.side).toBe("SELL");
		}
	});

	test("exit signal closes a long at slipped-down price (SELL receives less)", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");
		const { eq } = await import("drizzle-orm");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "slippage_exit_long",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({ entry_long: "rsi14 < 20", exit: "hold_days >= 0" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10_000,
				generation: 1,
			})
			.returning();

		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 140,
			quantity: 10,
			signalType: "entry_long",
			reasoning: "test open",
		});

		const result = await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: VALID_QUOTE,
			indicators: VALID_INDICATORS,
		});

		expect(result.kind).toBe("exited");

		const trades = await db.select().from(paperTrades).where(eq(paperTrades.strategyId, strat!.id));
		const exitTrade = trades.find((t) => t.signalType === "exit");
		expect(exitTrade).toBeDefined();
		// 150 * (1 - 5/10000) = 149.925
		expect(exitTrade!.price).toBeCloseTo(149.925, 5);
	});
});
