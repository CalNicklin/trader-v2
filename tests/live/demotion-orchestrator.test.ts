import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { graduationEvents, liveTrades, strategies, strategyMetrics } from "../../src/db/schema.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("runDemotionChecks", () => {
	test("kills strategy when not profitable after 60 live trades", async () => {
		const db = getDb();

		// Insert a probation strategy
		const [strategy] = await db
			.insert(strategies)
			.values({
				name: "Test Strategy",
				description: "Test",
				parameters: "{}",
				signals: "{}",
				universe: "[]",
				status: "probation",
				virtualBalance: 10000,
			})
			.returning();

		// Insert 60 filled trades with negative PnL
		const trades = Array.from({ length: 60 }, (_, i) => ({
			strategyId: strategy!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY" as const,
			quantity: 10,
			orderType: "LIMIT" as const,
			limitPrice: 100,
			fillPrice: 100,
			status: "FILLED" as const,
			pnl: -10,
			friction: 0,
			filledAt: new Date(Date.now() - i * 60000).toISOString(),
		}));
		await db.insert(liveTrades).values(trades);

		// Run demotion checks
		const { runDemotionChecks } = await import("../../src/live/executor.ts");
		await runDemotionChecks();

		// Strategy should be retired
		const [updated] = await db.select().from(strategies).where(eq(strategies.id, strategy!.id));
		expect(updated!.status).toBe("retired");

		// Should have a "killed" graduation event
		const events = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, strategy!.id));
		expect(events.some((e) => e.event === "killed")).toBe(true);
	});

	test("applies first strike on tier breach — reduces capital by 50%", async () => {
		const db = getDb();

		// Insert a probation strategy
		const [strategy] = await db
			.insert(strategies)
			.values({
				name: "Breaching Strategy",
				description: "Test",
				parameters: "{}",
				signals: "{}",
				universe: "[]",
				status: "probation",
				virtualBalance: 10000,
			})
			.returning();

		// Insert strategy metrics with negative Sharpe (will trigger probation tier breach)
		await db.insert(strategyMetrics).values({
			strategyId: strategy!.id,
			sampleSize: 25,
			sharpeRatio: -0.3,
			maxDrawdownPct: 5,
		});

		// Insert 25 filled trades with net positive PnL (so kill criteria won't fire)
		const trades = Array.from({ length: 25 }, (_, i) => ({
			strategyId: strategy!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY" as const,
			quantity: 10,
			orderType: "LIMIT" as const,
			limitPrice: 100,
			fillPrice: 100,
			status: "FILLED" as const,
			pnl: 10,
			friction: 0,
			filledAt: new Date(Date.now() - i * 60000).toISOString(),
		}));
		await db.insert(liveTrades).values(trades);

		// Run demotion checks
		const { runDemotionChecks } = await import("../../src/live/executor.ts");
		await runDemotionChecks();

		// Strategy should still be on probation (not killed/retired)
		const [updated] = await db.select().from(strategies).where(eq(strategies.id, strategy!.id));
		expect(updated!.status).toBe("probation");

		// Virtual balance should be halved (first strike: 50% capital reduction)
		expect(updated!.virtualBalance).toBe(5000);
	});

	test("skips strategies with no live trades", async () => {
		const db = getDb();

		// Insert a probation strategy with no trades
		const [strategy] = await db
			.insert(strategies)
			.values({
				name: "Idle Strategy",
				description: "Test",
				parameters: "{}",
				signals: "{}",
				universe: "[]",
				status: "probation",
				virtualBalance: 10000,
			})
			.returning();

		// Run demotion checks
		const { runDemotionChecks } = await import("../../src/live/executor.ts");
		await runDemotionChecks();

		// Strategy status and balance should be unchanged
		const [updated] = await db.select().from(strategies).where(eq(strategies.id, strategy!.id));
		expect(updated!.status).toBe("probation");
		expect(updated!.virtualBalance).toBe(10000);
	});
});
