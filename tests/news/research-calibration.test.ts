import { beforeEach, describe, expect, test } from "bun:test";

describe("news research calibration (Proposal #4)", () => {
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

	test("recordOutcome inserts a row with null realised fields at call time", async () => {
		const { recordOutcome } = await import("../../src/news/research-calibration.ts");
		const { researchOutcome } = await import("../../src/db/schema.ts");

		await recordOutcome({
			newsAnalysisId: 42,
			symbol: "ANET",
			exchange: "NASDAQ",
			predictedDirection: "long",
			confidence: 0.92,
			eventType: "analyst_upgrade",
			priceAtCall: 150,
		});

		const rows = await db.select().from(researchOutcome);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.predictedDirection).toBe("long");
		expect(rows[0]!.realisedMove24h).toBeNull();
		expect(rows[0]!.realisedMove48h).toBeNull();
	});

	test("backfillOutcomes fills realised moves from quotes_cache for rows older than window", async () => {
		const { recordOutcome, backfillOutcomes } = await import(
			"../../src/news/research-calibration.ts"
		);
		const { researchOutcome, quotesCache } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		// Insert a row that is "older than 24h" by manually backdating createdAt
		await recordOutcome({
			newsAnalysisId: 1,
			symbol: "ANET",
			exchange: "NASDAQ",
			predictedDirection: "long",
			confidence: 0.9,
			eventType: "analyst_upgrade",
			priceAtCall: 100,
		});
		await db
			.update(researchOutcome)
			.set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
			.where(eq(researchOutcome.newsAnalysisId, 1));

		await db.insert(quotesCache).values({ symbol: "ANET", exchange: "NASDAQ", last: 103 });

		const filled = await backfillOutcomes({ window: "24h" });

		expect(filled).toBe(1);
		const [row] = await db.select().from(researchOutcome);
		expect(row?.realisedMove24h).toBeCloseTo(0.03, 3);
		expect(row?.filled24hAt).toBeTruthy();
	});

	test("backfillOutcomes skips rows that are still within the window", async () => {
		const { recordOutcome, backfillOutcomes } = await import(
			"../../src/news/research-calibration.ts"
		);
		const { quotesCache } = await import("../../src/db/schema.ts");

		// Insert a fresh row (createdAt = now)
		await recordOutcome({
			newsAnalysisId: 2,
			symbol: "TSLA",
			exchange: "NASDAQ",
			predictedDirection: "short",
			confidence: 0.8,
			eventType: "earnings_miss",
			priceAtCall: 300,
		});
		await db.insert(quotesCache).values({ symbol: "TSLA", exchange: "NASDAQ", last: 290 });

		const filled = await backfillOutcomes({ window: "24h" });
		expect(filled).toBe(0);
	});
});
