import { beforeEach, describe, expect, test } from "bun:test";

describe("TRA-39 quarantine — LLM-reasoning consumers filter quarantined rows", () => {
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

	test("evolution analyzer excludes quarantined insights from strategy performance", async () => {
		const { strategies, tradeInsights } = await import("../../src/db/schema.ts");
		const { getStrategyPerformance } = await import("../../src/evolution/analyzer.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "quarantine_test",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({ entry_long: "x", exit: "y" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10_000,
				generation: 1,
			})
			.returning();

		await db.insert(tradeInsights).values([
			{
				strategyId: strat!.id,
				tradeId: null,
				insightType: "trade_review",
				tags: null,
				observation: "INVERTED_PRE_TRA37",
				suggestedAction: null,
				confidence: 0.9,
				promptVersion: 1,
				ledToImprovement: null,
				quarantined: 1,
				createdAt: "2026-04-20T00:00:00.000Z",
			},
			{
				strategyId: strat!.id,
				tradeId: null,
				insightType: "trade_review",
				tags: null,
				observation: "FRESH_POST_TRA37",
				suggestedAction: null,
				confidence: 0.9,
				promptVersion: 2,
				ledToImprovement: null,
				quarantined: 0,
				createdAt: "2026-04-23T00:00:00.000Z",
			},
		]);

		const perf = await getStrategyPerformance(strat!.id);
		expect(perf).not.toBeNull();
		expect(perf!.insightSummary).toContain("FRESH_POST_TRA37");
		expect(perf!.insightSummary).not.toContain("INVERTED_PRE_TRA37");
	});

	test("pattern-analysis ignores quarantined trade_review tags when clustering", async () => {
		const { strategies, paperTrades, tradeInsights } = await import("../../src/db/schema.ts");
		const { getRecentTradeClusters } = await import("../../src/learning/pattern-analysis.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "cluster_test",
				description: "test",
				parameters: JSON.stringify({}),
				signals: JSON.stringify({ entry_long: "x", exit: "y" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10_000,
				generation: 1,
			})
			.returning();

		// Two trades: one with a quarantined insight, one with a fresh one.
		const [tradeA] = await db
			.insert(paperTrades)
			.values({
				strategyId: strat!.id,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "SELL",
				quantity: 1,
				price: 100,
				friction: 0.2,
				pnl: -5,
				signalType: "exit",
				reasoning: "test",
				createdAt: new Date().toISOString(),
			})
			.returning();

		const [tradeB] = await db
			.insert(paperTrades)
			.values({
				strategyId: strat!.id,
				symbol: "MSFT",
				exchange: "NASDAQ",
				side: "SELL",
				quantity: 1,
				price: 200,
				friction: 0.4,
				pnl: 5,
				signalType: "exit",
				reasoning: "test",
				createdAt: new Date().toISOString(),
			})
			.returning();

		// Need a third trade so getRecentTradeClusters doesn't skip the strategy
		// (it requires trades.length >= 3 per cluster).
		await db.insert(paperTrades).values({
			strategyId: strat!.id,
			symbol: "GOOGL",
			exchange: "NASDAQ",
			side: "SELL",
			quantity: 1,
			price: 300,
			friction: 0.6,
			pnl: 1,
			signalType: "exit",
			reasoning: "test",
			createdAt: new Date().toISOString(),
		});

		await db.insert(tradeInsights).values([
			{
				strategyId: strat!.id,
				tradeId: tradeA!.id,
				insightType: "trade_review",
				tags: JSON.stringify(["INVERTED_TAG"]),
				observation: "pre-fix",
				suggestedAction: null,
				confidence: 0.9,
				promptVersion: 1,
				ledToImprovement: null,
				quarantined: 1,
				createdAt: "2026-04-20T00:00:00.000Z",
			},
			{
				strategyId: strat!.id,
				tradeId: tradeB!.id,
				insightType: "trade_review",
				tags: JSON.stringify(["FRESH_TAG"]),
				observation: "post-fix",
				suggestedAction: null,
				confidence: 0.9,
				promptVersion: 2,
				ledToImprovement: null,
				quarantined: 0,
				createdAt: "2026-04-23T00:00:00.000Z",
			},
		]);

		const clusters = await getRecentTradeClusters(14);
		const cluster = clusters.find((c) => c.strategyId === strat!.id);
		expect(cluster).toBeDefined();

		const tradeATags = cluster!.trades.find((t) => t.symbol === "AAPL")?.patternTags ?? [];
		const tradeBTags = cluster!.trades.find((t) => t.symbol === "MSFT")?.patternTags ?? [];
		expect(tradeATags).not.toContain("INVERTED_TAG");
		expect(tradeBTags).toContain("FRESH_TAG");
	});

	test("meta-evolution hit-rate denominators exclude quarantined rows", async () => {
		const { tradeInsights } = await import("../../src/db/schema.ts");
		const { computeHitRates } = await import("../../src/learning/meta-evolution.ts");

		// Setup: 2 quarantined trade_reviews that "led to improvement", 2 fresh
		// that didn't. If quarantined rows leak into the denominator, hit rate
		// would be 2/4 = 0.5. Filtered correctly it should be 0/2 = 0.
		await db.insert(tradeInsights).values([
			{
				insightType: "trade_review",
				observation: "quarantined-1",
				confidence: 0.9,
				ledToImprovement: true,
				quarantined: 1,
				createdAt: "2026-04-20T00:00:00.000Z",
			},
			{
				insightType: "trade_review",
				observation: "quarantined-2",
				confidence: 0.9,
				ledToImprovement: true,
				quarantined: 1,
				createdAt: "2026-04-20T00:00:00.000Z",
			},
			{
				insightType: "trade_review",
				observation: "fresh-1",
				confidence: 0.9,
				ledToImprovement: false,
				quarantined: 0,
				createdAt: "2026-04-23T00:00:00.000Z",
			},
			{
				insightType: "trade_review",
				observation: "fresh-2",
				confidence: 0.9,
				ledToImprovement: false,
				quarantined: 0,
				createdAt: "2026-04-23T00:00:00.000Z",
			},
		]);

		const rates = await computeHitRates();
		expect(rates.trade_review).toBe(0);
	});
});
