import { beforeEach, describe, expect, mock, test } from "bun:test";
import { strategies } from "../../src/db/schema.ts";

describe("runNewsPoll LSE branch (FMP)", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
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

	test("calls fetchFmpCompanyNews once per LSE symbol and routes to processArticle", async () => {
		const fmpCalls: Array<{ symbol: string; exchange: string }> = [];
		const processCalls: Array<{ headline: string; exchange: string }> = [];

		mock.module("../../src/news/fmp-news.ts", () => ({
			fetchFmpCompanyNews: async (symbol: string, exchange: string) => {
				fmpCalls.push({ symbol, exchange });
				if (symbol === "SHEL") {
					return [
						{
							headline: `Shell news ${Date.now()}-${Math.random()}`,
							symbols: ["SHEL"],
							url: "https://example.com/a",
							source: "reuters.com",
							publishedAt: new Date(),
							finnhubId: null,
						},
					];
				}
				return [];
			},
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

		expect(fmpCalls).toEqual([
			{ symbol: "SHEL", exchange: "LSE" },
			{ symbol: "BP.", exchange: "LSE" },
		]);
		expect(processCalls).toHaveLength(1);
		expect(processCalls[0]?.exchange).toBe("LSE");
	});
});
