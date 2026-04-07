import { beforeEach, describe, expect, test } from "bun:test";

describe("ledToImprovement tracking", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { tradeInsights } = await import("../../src/db/schema.ts");
		await db.delete(tradeInsights);
	});

	test("markMatchedInsights sets ledToImprovement=true for matching suggestions", async () => {
		const { tradeInsights } = await import("../../src/db/schema.ts");
		const { markMatchedInsights } = await import("../../src/evolution/index.ts");
		const { eq } = await import("drizzle-orm");

		const [insight] = await db
			.insert(tradeInsights)
			.values({
				strategyId: 1,
				insightType: "trade_review" as const,
				observation: "Stop too tight",
				suggestedAction: JSON.stringify({
					parameter: "stop_loss_pct",
					direction: "increase",
					reasoning: "Stops triggered on normal volatility",
				}),
				confidence: 0.8,
			})
			.returning();

		await markMatchedInsights(1, { stop_loss_pct: { from: 3, to: 5 } });

		const updated = await db.select().from(tradeInsights).where(eq(tradeInsights.id, insight!.id));
		expect(updated[0]!.ledToImprovement).toBe(true);
	});

	test("markMatchedInsights sets ledToImprovement=true for decrease direction", async () => {
		const { tradeInsights } = await import("../../src/db/schema.ts");
		const { markMatchedInsights } = await import("../../src/evolution/index.ts");
		const { eq } = await import("drizzle-orm");

		const [insight] = await db
			.insert(tradeInsights)
			.values({
				strategyId: 1,
				insightType: "pattern_analysis" as const,
				observation: "Holding too long",
				suggestedAction: JSON.stringify({
					parameter: "hold_days",
					direction: "decrease",
					reasoning: "Choppy market",
				}),
				confidence: 0.7,
			})
			.returning();

		await markMatchedInsights(1, { hold_days: { from: 10, to: 5 } });

		const updated = await db.select().from(tradeInsights).where(eq(tradeInsights.id, insight!.id));
		expect(updated[0]!.ledToImprovement).toBe(true);
	});

	test("markMatchedInsights does not mark insights where direction doesn't match", async () => {
		const { tradeInsights } = await import("../../src/db/schema.ts");
		const { markMatchedInsights } = await import("../../src/evolution/index.ts");
		const { eq } = await import("drizzle-orm");

		const [insight] = await db
			.insert(tradeInsights)
			.values({
				strategyId: 1,
				insightType: "trade_review" as const,
				observation: "Stop too tight",
				suggestedAction: JSON.stringify({
					parameter: "stop_loss_pct",
					direction: "increase",
					reasoning: "Stops triggered",
				}),
				confidence: 0.8,
			})
			.returning();

		await markMatchedInsights(1, { stop_loss_pct: { from: 5, to: 3 } });

		const updated = await db.select().from(tradeInsights).where(eq(tradeInsights.id, insight!.id));
		expect(updated[0]!.ledToImprovement).toBeNull();
	});

	test("markMatchedInsights marks old unmatched insights as false", async () => {
		const { tradeInsights } = await import("../../src/db/schema.ts");
		const { markMatchedInsights } = await import("../../src/evolution/index.ts");
		const { eq } = await import("drizzle-orm");

		const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
		const [oldInsight] = await db
			.insert(tradeInsights)
			.values({
				strategyId: 1,
				insightType: "trade_review" as const,
				observation: "RSI threshold off",
				suggestedAction: JSON.stringify({
					parameter: "rsi_oversold",
					direction: "decrease",
					reasoning: "Missing entries",
				}),
				confidence: 0.7,
				createdAt: tenDaysAgo,
			})
			.returning();

		await markMatchedInsights(1, { stop_loss_pct: { from: 3, to: 5 } });

		const updated = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.id, oldInsight!.id));
		expect(updated[0]!.ledToImprovement).toBe(false);
	});

	test("markMatchedInsights leaves recent unmatched insights as null", async () => {
		const { tradeInsights } = await import("../../src/db/schema.ts");
		const { markMatchedInsights } = await import("../../src/evolution/index.ts");
		const { eq } = await import("drizzle-orm");

		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const [recentInsight] = await db
			.insert(tradeInsights)
			.values({
				strategyId: 1,
				insightType: "trade_review" as const,
				observation: "RSI threshold off",
				suggestedAction: JSON.stringify({
					parameter: "rsi_oversold",
					direction: "decrease",
					reasoning: "Missing entries",
				}),
				confidence: 0.7,
				createdAt: twoDaysAgo,
			})
			.returning();

		await markMatchedInsights(1, { stop_loss_pct: { from: 3, to: 5 } });

		const updated = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.id, recentInsight!.id));
		expect(updated[0]!.ledToImprovement).toBeNull();
	});
});
