import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("paper manager", () => {
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

	async function insertStrategy(balance = 10000) {
		const { strategies } = await import("../../src/db/schema.ts");
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_strat",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				status: "paper" as const,
				virtualBalance: balance,
				generation: 1,
			})
			.returning();
		return strat!;
	}

	test("openPaperPosition creates position and trade records", async () => {
		const { openPaperPosition } = await import("../../src/paper/manager.ts");
		const { paperPositions, paperTrades, strategies } = await import("../../src/db/schema.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "RSI oversold",
		});

		const positions = await db.select().from(paperPositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.symbol).toBe("AAPL");
		expect(positions[0]!.quantity).toBe(6);
		expect(positions[0]!.entryPrice).toBe(150);

		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(1);
		expect(trades[0]!.side).toBe("BUY");
		expect(trades[0]!.friction).toBeGreaterThan(0);

		const [updatedStrat] = await db.select().from(strategies).where(eq(strategies.id, strat.id));
		expect(updatedStrat!.virtualBalance).toBeLessThan(10000);
	});

	test("closePaperPosition closes position and records P&L", async () => {
		const { openPaperPosition, closePaperPosition } = await import("../../src/paper/manager.ts");
		const { paperPositions, paperTrades, strategies } = await import("../../src/db/schema.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "RSI oversold",
		});

		const [position] = await db.select().from(paperPositions);

		await closePaperPosition({
			positionId: position!.id,
			strategyId: strat.id,
			exitPrice: 160,
			signalType: "exit",
			reasoning: "Target hit",
		});

		const [closedPos] = await db.select().from(paperPositions);
		expect(closedPos!.closedAt).not.toBeNull();

		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(2);

		const exitTrade = trades.find((t) => t.signalType === "exit");
		expect(exitTrade!.pnl).not.toBeNull();
		expect(exitTrade!.pnl!).toBeGreaterThan(0);

		const [updatedStrat] = await db.select().from(strategies).where(eq(strategies.id, strat.id));
		expect(updatedStrat!.virtualBalance).toBeGreaterThan(10000 - 6 * 150);
	});

	test("getOpenPositions returns only open positions for a strategy", async () => {
		const { openPaperPosition, getOpenPositions } = await import("../../src/paper/manager.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "test",
		});

		const positions = await getOpenPositions(strat.id);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.closedAt).toBeNull();
	});

	test("markPositionsToMarket updates currentPrice and unrealizedPnl from quotes", async () => {
		const { openPaperPosition, markPositionsToMarket } = await import("../../src/paper/manager.ts");
		const { paperPositions, quotesCache } = await import("../../src/db/schema.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "test",
		});

		await db.insert(quotesCache).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 160,
		});

		const updated = await markPositionsToMarket();
		expect(updated).toBe(1);

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.currentPrice).toBe(160);
		expect(positions[0]!.unrealizedPnl).toBe(60);
		expect(positions[0]!.highWaterMark).toBe(160);
	});

	test("markPositionsToMarket handles SHORT positions correctly", async () => {
		const { openPaperPosition, markPositionsToMarket } = await import("../../src/paper/manager.ts");
		const { paperPositions, quotesCache } = await import("../../src/db/schema.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "SELL",
			price: 150,
			quantity: 6,
			signalType: "entry_short",
			reasoning: "test",
		});

		await db.insert(quotesCache).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 140,
		});

		const updated = await markPositionsToMarket();
		expect(updated).toBe(1);

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.currentPrice).toBe(140);
		expect(positions[0]!.unrealizedPnl).toBe(60);
		expect(positions[0]!.highWaterMark).toBe(140);
	});

	test("markPositionsToMarket tracks high water mark across updates", async () => {
		const { openPaperPosition, markPositionsToMarket } = await import("../../src/paper/manager.ts");
		const { paperPositions, quotesCache } = await import("../../src/db/schema.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "test",
		});

		await db.insert(quotesCache).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 170,
		});
		await markPositionsToMarket();

		await db.update(quotesCache).set({ last: 160 }).where(eq(quotesCache.symbol, "AAPL"));
		await markPositionsToMarket();

		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.currentPrice).toBe(160);
		expect(positions[0]!.unrealizedPnl).toBe(60);
		expect(positions[0]!.highWaterMark).toBe(170);
	});
});
