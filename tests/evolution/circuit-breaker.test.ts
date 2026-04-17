import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("checkConsecutiveLossPause", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { graduationEvents, paperTrades, strategies, tradeInsights } = await import(
			"../../src/db/schema.ts"
		);
		await db.delete(graduationEvents);
		await db.delete(paperTrades);
		await db.delete(tradeInsights);
		await db.delete(strategies);
	});

	async function insertPaperStrategy(virtualBalance = 10000) {
		const { strategies } = await import("../../src/db/schema.ts");
		const [row] = await db
			.insert(strategies)
			.values({
				name: "circuit_breaker_test",
				description: "Test strategy for circuit breaker",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance,
				generation: 1,
			})
			.returning();
		return row!.id;
	}

	async function insertTrade(strategyId: number, pnl: number) {
		const { paperTrades } = await import("../../src/db/schema.ts");
		await db.insert(paperTrades).values({
			strategyId,
			symbol: "TEST",
			exchange: "NASDAQ",
			side: "BUY" as const,
			quantity: 1,
			price: 100,
			friction: 0,
			pnl,
			signalType: "exit",
		});
	}

	test("pauses on 5 consecutive losses", async () => {
		const { checkConsecutiveLossPause } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		const id = await insertPaperStrategy();
		for (let i = 0; i < 5; i++) {
			await insertTrade(id, -10);
		}

		const paused = await checkConsecutiveLossPause();

		expect(paused).toContain(id);
		const row = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(row?.status).toBe("paused");
	});

	test("does NOT pause on 4 consecutive losses followed by 1 win (most recent = win)", async () => {
		const { checkConsecutiveLossPause } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		const id = await insertPaperStrategy();
		// Insert 4 losses first (older), then 1 win (most recent)
		for (let i = 0; i < 4; i++) {
			await insertTrade(id, -10);
		}
		await insertTrade(id, 20); // most recent = win

		const paused = await checkConsecutiveLossPause();

		expect(paused).not.toContain(id);
		const row = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(row?.status).toBe("paper");
	});

	test("pauses on single trade ≥5% of virtualBalance loss", async () => {
		const { checkConsecutiveLossPause } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		const id = await insertPaperStrategy(1000);
		// 5% of 1000 = 50; pnl of -55 exceeds that
		await insertTrade(id, -55);

		const paused = await checkConsecutiveLossPause();

		expect(paused).toContain(id);
		const row = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(row?.status).toBe("paused");
	});

	test("does NOT pause on single trade < 5% of virtualBalance", async () => {
		const { checkConsecutiveLossPause } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		const id = await insertPaperStrategy(1000);
		// 5% of 1000 = 50; pnl of -40 is 4%, should NOT trigger
		await insertTrade(id, -40);

		const paused = await checkConsecutiveLossPause();

		expect(paused).not.toContain(id);
		const row = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(row?.status).toBe("paper");
	});

	test("pauses on pattern_analysis insight with tag 'filter_failure' and conf 0.9", async () => {
		const { checkConsecutiveLossPause } = await import("../../src/evolution/population.ts");
		const { strategies, tradeInsights } = await import("../../src/db/schema.ts");

		const id = await insertPaperStrategy();
		await db.insert(tradeInsights).values({
			strategyId: id,
			insightType: "pattern_analysis",
			tags: JSON.stringify(["filter_failure"]),
			observation: "repeated filter_failure pattern observed",
			confidence: 0.9,
		});

		const paused = await checkConsecutiveLossPause();

		expect(paused).toContain(id);
		const row = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(row?.status).toBe("paused");
	});

	test("does NOT pause on pattern_analysis insight with conf 0.84 (below threshold)", async () => {
		const { checkConsecutiveLossPause } = await import("../../src/evolution/population.ts");
		const { strategies, tradeInsights } = await import("../../src/db/schema.ts");

		const id = await insertPaperStrategy();
		await db.insert(tradeInsights).values({
			strategyId: id,
			insightType: "pattern_analysis",
			tags: JSON.stringify(["filter_failure"]),
			observation: "pattern observed but confidence too low",
			confidence: 0.84,
		});

		const paused = await checkConsecutiveLossPause();

		expect(paused).not.toContain(id);
		const row = await db.select().from(strategies).where(eq(strategies.id, id)).get();
		expect(row?.status).toBe("paper");
	});
});
