import { beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../src/db/client.ts";
import { strategies } from "../../src/db/schema.ts";
import type { YahooRssItem } from "../../src/news/yahoo-rss-uk.ts";
import { runNewsPoll } from "../../src/scheduler/news-poll-job.ts";

describe("runNewsPoll LSE branch (Yahoo RSS)", () => {
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

	test("calls fetchYahooRssUk once per LSE symbol and routes adapted article to processArticle", async () => {
		const yahooCalls: Array<{ symbol: string; exchange: string }> = [];
		const processCalls: Array<{ headline: string; exchange: string }> = [];

		const fetchYahooRssStub = async (symbol: string, exchange: string): Promise<YahooRssItem[]> => {
			yahooCalls.push({ symbol, exchange });
			if (symbol === "SHEL") {
				return [
					{
						title: `Shell news ${Date.now()}-${Math.random()}`,
						pubDate: "Mon, 20 Apr 2026 10:00:00 +0000",
						link: "https://example.com/a",
						description: "Shell Q1 results beat expectations",
						source: "yahoo_rss",
					},
				];
			}
			return [];
		};

		await runNewsPoll({
			fetchYahooRssUk: fetchYahooRssStub,
			fetchCompanyNews: async () => [],
			processArticle: async (article, exchange) => {
				processCalls.push({ headline: article.headline, exchange });
				return "classified";
			},
		});

		expect(yahooCalls).toEqual([
			{ symbol: "SHEL", exchange: "LSE" },
			{ symbol: "BP.", exchange: "LSE" },
		]);
		expect(processCalls).toHaveLength(1);
		expect(processCalls[0]?.exchange).toBe("LSE");
		expect(processCalls[0]?.headline).toStartWith("Shell news");
	});
});
