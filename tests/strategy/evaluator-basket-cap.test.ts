import { beforeEach, describe, expect, test } from "bun:test";

describe("evaluator basket-cap enforcement", () => {
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

	test("tickWouldBreachCap returns true when proposed opens + existing > cap", async () => {
		const { tickWouldBreachCap } = await import("../../src/risk/basket-cap.ts");
		expect(tickWouldBreachCap(0, 7, 3)).toBe(true);
		expect(tickWouldBreachCap(2, 2, 3)).toBe(true);
		expect(tickWouldBreachCap(0, 3, 3)).toBe(false);
		expect(tickWouldBreachCap(1, 2, 3)).toBe(false);
	});

	test("default MAX_CONCURRENT_POSITIONS is 6 (TRA-12)", async () => {
		const { MAX_CONCURRENT_POSITIONS } = await import("../../src/risk/constants.ts");
		expect(MAX_CONCURRENT_POSITIONS).toBe(6);
	});

	test("tickWouldBreachCap defaults to the exported constant", async () => {
		const { tickWouldBreachCap } = await import("../../src/risk/basket-cap.ts");
		// With cap defaulted to 6: 6 proposals from empty book allowed; 7 rejected.
		expect(tickWouldBreachCap(0, 6)).toBe(false);
		expect(tickWouldBreachCap(0, 7)).toBe(true);
		expect(tickWouldBreachCap(3, 4)).toBe(true);
		expect(tickWouldBreachCap(3, 3)).toBe(false);
	});

	test("evaluator rejects tick when 7 entries are proposed simultaneously", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		await db.insert(strategies).values({
			name: "basket_fire",
			description: "fires short on every tick",
			parameters: JSON.stringify({ position_size_pct: 5 }),
			signals: JSON.stringify({
				entry_long: "0 > 1",
				entry_short: "1 > 0",
				exit: "0 > 1",
			}),
			universe: JSON.stringify(["AMD", "META", "TSLA", "NVDA", "GOOGL", "AVGO", "AAPL"]),
			status: "paper" as const,
			virtualBalance: 10000,
			generation: 1,
		});

		const { evaluateAllStrategies } = await import("../../src/strategy/evaluator.ts");
		const stubGetQuote = async (symbol: string, exchange: string) => ({
			quote: {
				symbol,
				exchange,
				last: 100,
				bid: 99.9,
				ask: 100.1,
				volume: 1_000_000,
				avgVolume: 1_000_000,
				changePercent: 0,
				newsSentiment: -0.5,
			} as any,
			indicators: { atr14: 2, rsi14: 60, volume_ratio: 1.5 } as any,
		});

		await evaluateAllStrategies(stubGetQuote);

		const { paperPositions } = await import("../../src/db/schema.ts");
		const openPositions = await db.select().from(paperPositions);
		expect(openPositions.length).toBe(0);
	});
});
