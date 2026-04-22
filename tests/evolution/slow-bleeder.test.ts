import { beforeEach, describe, expect, test } from "bun:test";

describe("slow-bleeder soft-demote (TRA-13)", () => {
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

	const setupStrategyWith = async (opts: {
		name: string;
		sampleSize: number;
		winRate: number;
		sharpe: number;
		failureTagCount: number;
		nonFailureReviewCount: number;
	}) => {
		const { strategies, strategyMetrics, tradeInsights } = await import("../../src/db/schema.ts");
		const [strat] = await db
			.insert(strategies)
			.values({
				name: opts.name,
				description: "test",
				parameters: JSON.stringify({ stop_loss_pct: 5 }),
				signals: JSON.stringify({ entry_long: "x", exit: "y" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10_000,
				generation: 1,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strat!.id,
			sampleSize: opts.sampleSize,
			winRate: opts.winRate,
			expectancy: -28,
			profitFactor: 0.4,
			sharpeRatio: opts.sharpe,
			sortinoRatio: null,
			maxDrawdownPct: 0.04,
			calmarRatio: null,
			consistencyScore: null,
		});

		const recent = new Date().toISOString();
		const insights: Array<{
			strategyId: number;
			insightType: "trade_review";
			tags: string | null;
			observation: string;
			confidence: number;
			quarantined: number;
			createdAt: string;
		}> = [];
		for (let i = 0; i < opts.failureTagCount; i++) {
			insights.push({
				strategyId: strat!.id,
				insightType: "trade_review",
				tags: JSON.stringify(["filter_failure"]),
				observation: `fail-${i}`,
				confidence: 0.9,
				quarantined: 0,
				createdAt: recent,
			});
		}
		for (let i = 0; i < opts.nonFailureReviewCount; i++) {
			insights.push({
				strategyId: strat!.id,
				insightType: "trade_review",
				tags: JSON.stringify([]),
				observation: `clean-${i}`,
				confidence: 0.9,
				quarantined: 0,
				createdAt: recent,
			});
		}
		if (insights.length > 0) {
			await db.insert(tradeInsights).values(insights);
		}
		return strat!;
	};

	test("demotes a strategy that meets ALL four criteria", async () => {
		const { checkSlowBleederPause } = await import("../../src/evolution/slow-bleeder.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const strat = await setupStrategyWith({
			name: "bleeder",
			sampleSize: 10,
			winRate: 0.3,
			sharpe: -3,
			failureTagCount: 5,
			nonFailureReviewCount: 3,
		});

		const paused = await checkSlowBleederPause();
		expect(paused).toContain(strat.id);

		const [updated] = await db.select().from(strategies).where(eq(strategies.id, strat.id));
		expect(updated!.status).toBe("paused");
	});

	test("does NOT demote when sample size is below 8", async () => {
		const { checkSlowBleederPause } = await import("../../src/evolution/slow-bleeder.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const strat = await setupStrategyWith({
			name: "new_bleeder",
			sampleSize: 7,
			winRate: 0.3,
			sharpe: -3,
			failureTagCount: 5,
			nonFailureReviewCount: 3,
		});

		const paused = await checkSlowBleederPause();
		expect(paused).not.toContain(strat.id);

		const [updated] = await db.select().from(strategies).where(eq(strategies.id, strat.id));
		expect(updated!.status).toBe("paper");
	});

	test("does NOT demote when Sharpe is above -2", async () => {
		const { checkSlowBleederPause } = await import("../../src/evolution/slow-bleeder.ts");
		const strat = await setupStrategyWith({
			name: "bad_but_ok",
			sampleSize: 10,
			winRate: 0.3,
			sharpe: -1.5,
			failureTagCount: 5,
			nonFailureReviewCount: 3,
		});
		const paused = await checkSlowBleederPause();
		expect(paused).not.toContain(strat.id);
	});

	test("does NOT demote when win rate is above 0.35", async () => {
		const { checkSlowBleederPause } = await import("../../src/evolution/slow-bleeder.ts");
		const strat = await setupStrategyWith({
			name: "decent_wr",
			sampleSize: 10,
			winRate: 0.4,
			sharpe: -3,
			failureTagCount: 5,
			nonFailureReviewCount: 3,
		});
		const paused = await checkSlowBleederPause();
		expect(paused).not.toContain(strat.id);
	});

	test("does NOT demote when mechanism-failure tag evidence is weak (tag-coupled trigger)", async () => {
		const { checkSlowBleederPause } = await import("../../src/evolution/slow-bleeder.ts");
		const strat = await setupStrategyWith({
			name: "bad_stats_no_tags",
			sampleSize: 10,
			winRate: 0.3,
			sharpe: -3,
			failureTagCount: 1,
			nonFailureReviewCount: 7, // 1/8 = 0.125 rate — below threshold
		});
		const paused = await checkSlowBleederPause();
		expect(paused).not.toContain(strat.id);
	});

	test("records the demotion as a graduation_event", async () => {
		const { checkSlowBleederPause } = await import("../../src/evolution/slow-bleeder.ts");
		const { graduationEvents } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const strat = await setupStrategyWith({
			name: "event_bleeder",
			sampleSize: 10,
			winRate: 0.3,
			sharpe: -3,
			failureTagCount: 5,
			nonFailureReviewCount: 3,
		});

		await checkSlowBleederPause();

		const events = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, strat.id));
		const pauseEvent = events.find((e) => e.event === "paused");
		expect(pauseEvent).toBeDefined();
		expect(pauseEvent!.evidence).toContain("slow_bleeder");
	});

	test("ignores already-paused strategies", async () => {
		const { checkSlowBleederPause } = await import("../../src/evolution/slow-bleeder.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		const strat = await setupStrategyWith({
			name: "already_paused",
			sampleSize: 10,
			winRate: 0.3,
			sharpe: -3,
			failureTagCount: 5,
			nonFailureReviewCount: 3,
		});
		await db
			.update(strategies)
			.set({ status: "paused" as const })
			.where(eq(strategies.id, strat.id));

		const paused = await checkSlowBleederPause();
		expect(paused).not.toContain(strat.id);
	});
});
