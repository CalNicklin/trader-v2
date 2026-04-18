import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { watchlist } from "../../src/db/schema.ts";
import { runWatchlistEnrichJob } from "../../src/scheduler/watchlist-enrich-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

function insertUnenriched(symbol: string) {
	const now = new Date().toISOString();
	getDb()
		.insert(watchlist)
		.values({
			symbol,
			exchange: "NASDAQ",
			promotionReasons: "news",
			promotedAt: now,
			lastCatalystAt: now,
			expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
		})
		.run();
}

describe("runWatchlistEnrichJob", () => {
	test("enriches unenriched rows via injected LLM", async () => {
		insertUnenriched("AAPL");
		insertUnenriched("MSFT");

		const llm = async () =>
			JSON.stringify({
				catalyst_summary: "x",
				directional_bias: "long",
				horizon: "days",
				status: "active",
			});

		const result = await runWatchlistEnrichJob({ llm, budgetCheck: async () => true });
		expect(result.enriched).toBe(2);

		const rows = getDb().select().from(watchlist).all();
		expect(rows.every((r) => r.enrichedAt != null)).toBe(true);
	});

	test("skips entire batch when budget exhausted", async () => {
		insertUnenriched("AAPL");
		const llm = async () => "";
		const result = await runWatchlistEnrichJob({ llm, budgetCheck: async () => false });
		expect(result.enriched).toBe(0);
		expect(result.skippedDueToBudget).toBe(1);
	});

	test("marks enrichment_failed_at after retry window on sustained parse failure", async () => {
		insertUnenriched("AAPL");

		const llm = async () => "not json";
		await runWatchlistEnrichJob({ llm, budgetCheck: async () => true });

		// Simulate a row whose promotedAt is older than ENRICHMENT_RETRY_HOURS
		getDb()
			.update(watchlist)
			.set({
				promotedAt: new Date(Date.now() - 30 * 3600_000).toISOString(),
			})
			.where(eq(watchlist.symbol, "AAPL"))
			.run();

		await runWatchlistEnrichJob({ llm, budgetCheck: async () => true });

		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).get();
		expect(row?.enrichmentFailedAt).not.toBeNull();
	});
});
