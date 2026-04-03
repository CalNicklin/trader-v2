import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("schema", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		// Create tables in :memory: DB
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("can insert and query a strategy", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		await db.insert(strategies).values({
			name: "test_strategy",
			description: "A test strategy",
			parameters: JSON.stringify({ rsi_threshold: 30 }),
			status: "paper",
			virtualBalance: 10000,
			generation: 1,
		});

		const rows = await db.select().from(strategies);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.name).toBe("test_strategy");
		expect(rows[0]!.status).toBe("paper");
		expect(rows[0]!.virtualBalance).toBe(10000);
	});

	test("can insert and query a paper trade", async () => {
		const { strategies, paperTrades } = await import("../../src/db/schema.ts");
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test",
				description: "test",
				parameters: "{}",
				status: "paper",
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(paperTrades).values({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			quantity: 5,
			price: 150.0,
			signalType: "entry_long",
			reasoning: "RSI oversold + positive news",
		});

		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(1);
		expect(trades[0]!.symbol).toBe("AAPL");
		expect(trades[0]!.side).toBe("BUY");
	});

	test("can insert and query quotes cache", async () => {
		const { quotesCache } = await import("../../src/db/schema.ts");
		await db.insert(quotesCache).values({
			symbol: "SHEL",
			exchange: "LSE",
			last: 2450.5,
			bid: 2449.0,
			ask: 2452.0,
			volume: 1200000,
			newsSentiment: 0.7,
		});

		const rows = await db.select().from(quotesCache).where(eq(quotesCache.symbol, "SHEL"));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.last).toBe(2450.5);
		expect(rows[0]!.newsSentiment).toBe(0.7);
	});

	test("can insert and query strategy metrics", async () => {
		const { strategies, strategyMetrics } = await import("../../src/db/schema.ts");
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test",
				description: "test",
				parameters: "{}",
				status: "paper",
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strat!.id,
			sampleSize: 35,
			winRate: 0.58,
			expectancy: 2.5,
			profitFactor: 1.45,
			sharpeRatio: 0.72,
			sortinoRatio: 1.1,
			maxDrawdownPct: 8.5,
			calmarRatio: 1.2,
			consistencyScore: 3,
		});

		const rows = await db.select().from(strategyMetrics);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.profitFactor).toBe(1.45);
	});
});
