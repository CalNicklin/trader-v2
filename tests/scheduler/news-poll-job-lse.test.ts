import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../src/db/client.ts";
import { strategies } from "../../src/db/schema.ts";

describe("runNewsPoll LSE branch (FMP)", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		await db.delete(strategies).execute();
		await db.insert(strategies).values({
			name: "lse-test",
			description: "test",
			parameters: "{}",
			universe: JSON.stringify(["SHEL:LSE", "BP.:LSE"]),
			status: "paper",
		});
	});

	test("calls FMP once per LSE symbol and routes articles to processArticle", async () => {
		const fmpCalls: string[] = [];
		const processCalls: Array<{ headline: string; exchange: string }> = [];

		// Mock the LOWEST level — src/data/fmp.ts — so the real
		// fetchFmpCompanyNews code path runs inside the test.
		// This avoids replacing src/news/fmp-news.ts in the module
		// cache, which would break fmp-news.test.ts's parser tests
		// when both files run in the same bun test invocation.
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async (_path: string, params: Record<string, string>) => {
				const symbols = params.symbols ?? "";
				fmpCalls.push(symbols);
				if (symbols === "SHEL.L") {
					return [
						{
							symbol: "SHEL",
							publishedDate: "2026-04-08 03:46:00",
							publisher: "Reuters",
							title: `Shell news ${Date.now()}-${Math.random()}`,
							url: "https://example.com/a",
							site: "reuters.com",
						},
					];
				}
				// BP.L and the BP fallback both return empty —
				// fetchFmpCompanyNews should log and return [].
				return [];
			},
			toFmpSymbol: (sym: string, exch: string) =>
				exch === "LSE" || exch === "AIM" ? `${sym}.L` : sym,
		}));

		mock.module("../../src/news/ingest.ts", () => ({
			processArticle: async (article: { headline: string }, exchange: string) => {
				processCalls.push({ headline: article.headline, exchange });
				return "classified";
			},
			isHeadlineSeen: async () => false,
		}));

		mock.module("../../src/news/finnhub.ts", () => ({
			fetchCompanyNews: async () => [],
		}));

		const { runNewsPoll } = await import("../../src/scheduler/news-poll-job.ts");
		await runNewsPoll();

		// SHEL.L returns one article on the primary call → no fallback
		// BP.L returns [] → fallback tries plain "BP" → also [] → skip
		expect(fmpCalls).toEqual(["SHEL.L", "BP.L", "BP"]);
		expect(processCalls).toHaveLength(1);
		expect(processCalls[0]?.exchange).toBe("LSE");
		expect(processCalls[0]?.headline).toStartWith("Shell news");
	});
});
