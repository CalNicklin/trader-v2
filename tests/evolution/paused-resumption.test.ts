import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("checkPausedForResumption", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { graduationEvents, strategies, strategyMetrics, paperTrades, strategyMutations } =
			await import("../../src/db/schema.ts");
		await db.delete(paperTrades);
		await db.delete(graduationEvents);
		await db.delete(strategyMutations);
		await db.delete(strategyMetrics);
		await db.delete(strategies);
	});

	test("resumes quarantine-paused strategy with 0 trades", async () => {
		const { strategies, graduationEvents } = await import("../../src/db/schema.ts");
		const { checkPausedForResumption } = await import("../../src/evolution/population.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "quarantined_child",
				description: "A quarantined strategy",
				parameters: "{}",
				status: "paused" as const,
				virtualBalance: 5000,
				generation: 2,
			})
			.returning();

		await db.insert(graduationEvents).values({
			strategyId: strat!.id,
			event: "paused" as const,
			evidence: JSON.stringify({
				reason:
					"TRA-5 audit: parent strategy 3 reviewer labels inverted; mutation children quarantined",
			}),
		});

		const resumed = await checkPausedForResumption();

		expect(resumed).toEqual([strat!.id]);

		const updated = await db.select().from(strategies).where(eq(strategies.id, strat!.id)).get();
		expect(updated!.status).toBe("paper");
		expect(updated!.virtualBalance).toBe(10_000);
	});

	test("does NOT resume paused strategy with existing trades", async () => {
		const { strategies, graduationEvents, paperTrades } = await import("../../src/db/schema.ts");
		const { checkPausedForResumption } = await import("../../src/evolution/population.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "traded_paused",
				description: "A paused strategy with trades",
				parameters: "{}",
				status: "paused" as const,
				virtualBalance: 5000,
				generation: 2,
			})
			.returning();

		await db.insert(graduationEvents).values({
			strategyId: strat!.id,
			event: "paused" as const,
			evidence: JSON.stringify({ reason: "quarantined pending fix" }),
		});

		await db.insert(paperTrades).values({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY" as const,
			quantity: 1,
			price: 150,
			signalType: "entry_long",
		});

		const resumed = await checkPausedForResumption();
		expect(resumed).toEqual([]);
	});

	test("does NOT resume strategy paused for slow bleeder", async () => {
		const { strategies, graduationEvents } = await import("../../src/db/schema.ts");
		const { checkPausedForResumption } = await import("../../src/evolution/population.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "slow_bleeder_paused",
				description: "Paused for slow bleeding",
				parameters: "{}",
				status: "paused" as const,
				virtualBalance: 5000,
				generation: 1,
			})
			.returning();

		await db.insert(graduationEvents).values({
			strategyId: strat!.id,
			event: "paused" as const,
			evidence: JSON.stringify({
				reason: "slow_bleeder",
				sampleSize: 10,
				sharpeRatio: -3,
				winRate: 0.3,
			}),
		});

		const resumed = await checkPausedForResumption();
		expect(resumed).toEqual([]);
	});

	test("does NOT resume strategy paused for consecutive losses", async () => {
		const { strategies, graduationEvents } = await import("../../src/db/schema.ts");
		const { checkPausedForResumption } = await import("../../src/evolution/population.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "loss_paused",
				description: "Paused for consecutive losses",
				parameters: "{}",
				status: "paused" as const,
				virtualBalance: 5000,
				generation: 1,
			})
			.returning();

		await db.insert(graduationEvents).values({
			strategyId: strat!.id,
			event: "paused" as const,
			evidence: JSON.stringify({ reason: "5 consecutive losing trades" }),
		});

		const resumed = await checkPausedForResumption();
		expect(resumed).toEqual([]);
	});

	test("records graduation event when resuming", async () => {
		const { strategies, graduationEvents } = await import("../../src/db/schema.ts");
		const { checkPausedForResumption } = await import("../../src/evolution/population.ts");
		const { desc } = await import("drizzle-orm");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "quarantined_resume_event",
				description: "Test event recording",
				parameters: "{}",
				status: "paused" as const,
				virtualBalance: 3000,
				generation: 2,
			})
			.returning();

		await db.insert(graduationEvents).values({
			strategyId: strat!.id,
			event: "paused" as const,
			evidence: JSON.stringify({ reason: "TRA-5 audit fix pending" }),
		});

		await checkPausedForResumption();

		const events = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, strat!.id))
			.orderBy(desc(graduationEvents.createdAt))
			.all();

		const resumeEvent = events.find((e) => e.event === "promoted");
		expect(resumeEvent).toBeDefined();
		expect(resumeEvent!.fromTier).toBe("paused");
		expect(resumeEvent!.toTier).toBe("paper");

		const evidence = JSON.parse(resumeEvent!.evidence!);
		expect(evidence.reason).toBe("quarantine_resolved");
	});
});
