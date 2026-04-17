import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("LSE same-symbol BUY cooldown", () => {
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

	async function insertStrategy() {
		const { strategies } = await import("../../src/db/schema.ts");
		const [row] = await db
			.insert(strategies)
			.values({
				name: "lse_test",
				description: "x",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();
		return row!;
	}

	test("second LSE BUY within 4h is rejected with WouldBreachCooldownError", async () => {
		const { openPaperPosition, WouldBreachCooldownError } = await import(
			"../../src/paper/manager.ts"
		);
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "HSBA",
			exchange: "LSE",
			side: "BUY",
			price: 1350,
			quantity: 1,
			signalType: "entry_long",
			reasoning: "test",
		});

		await expect(
			openPaperPosition({
				strategyId: strat.id,
				symbol: "HSBA",
				exchange: "LSE",
				side: "BUY",
				price: 1340,
				quantity: 1,
				signalType: "entry_long",
				reasoning: "test",
			}),
		).rejects.toBeInstanceOf(WouldBreachCooldownError);
	});

	test("NASDAQ BUYs are unaffected (cooldown is LSE-only)", async () => {
		const { openPaperPosition } = await import("../../src/paper/manager.ts");
		const { paperPositions } = await import("../../src/db/schema.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 250,
			quantity: 1,
			signalType: "entry_long",
			reasoning: "test",
		});
		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 251,
			quantity: 1,
			signalType: "entry_long",
			reasoning: "test",
		});

		const positions = await db
			.select()
			.from(paperPositions)
			.where(eq(paperPositions.strategyId, strat.id));
		expect(positions.length).toBe(2);
	});

	test("SELL-to-cover on LSE is NOT blocked (only BUYs are)", async () => {
		const { openPaperPosition } = await import("../../src/paper/manager.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "HSBA",
			exchange: "LSE",
			side: "SELL",
			price: 1350,
			quantity: 1,
			signalType: "entry_short",
			reasoning: "test",
		});
		// A subsequent SELL (short-cover or new short) must NOT throw
		await openPaperPosition({
			strategyId: strat.id,
			symbol: "HSBA",
			exchange: "LSE",
			side: "SELL",
			price: 1330,
			quantity: 1,
			signalType: "entry_short",
			reasoning: "test",
		});
	});
});
