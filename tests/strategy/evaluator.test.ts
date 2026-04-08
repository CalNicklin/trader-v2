import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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

	test("evaluateStrategy opens position when entry signal fires", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");

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

		await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
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

		const positions = await db.select().from(paperPositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.symbol).toBe("AAPL");

		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(1);
		expect(trades[0]!.side).toBe("BUY");
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

	test("evaluateStrategy blocks re-entry during cooldown period", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition, closePaperPosition } = await import("../../src/paper/manager.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_cooldown",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "last > 0",
					exit: "hold_days >= 0",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Open and immediately close a position
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

		const positions = await db.select().from(paperPositions);
		await closePaperPosition({
			positionId: positions[0]!.id,
			strategyId: strat!.id,
			exitPrice: 155,
			signalType: "exit",
			reasoning: "test exit",
		});

		// Refresh strategy row (balance changed)
		const [updatedStrat] = await db.select().from(strategies);

		// Now try to re-enter — should be blocked by cooldown
		await evaluateStrategyForSymbol(updatedStrat!, "AAPL", "NASDAQ", {
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

		// Should still only have the 1 closed position, no new entry
		const allPositions = await db.select().from(paperPositions);
		const openPositions = allPositions.filter((p) => !p.closedAt);
		expect(openPositions).toHaveLength(0);
	});
});
