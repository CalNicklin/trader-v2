import { beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../src/db/client.ts";
import { strategies } from "../../src/db/schema.ts";
import { runNewsPoll } from "../../src/scheduler/news-poll-job.ts";

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

	test("calls fetchFmpCompanyNews once per LSE symbol and routes to processArticle", async () => {
		const fmpCalls: Array<{ symbol: string; exchange: string }> = [];
		const processCalls: Array<{ headline: string; exchange: string }> = [];

		await runNewsPoll({
			fetchFmpCompanyNews: async (symbol, exchange) => {
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
			fetchCompanyNews: async () => [],
			processArticle: async (article, exchange) => {
				processCalls.push({ headline: article.headline, exchange });
				return "classified";
			},
		});

		expect(fmpCalls).toEqual([
			{ symbol: "SHEL", exchange: "LSE" },
			{ symbol: "BP.", exchange: "LSE" },
		]);
		expect(processCalls).toHaveLength(1);
		expect(processCalls[0]?.exchange).toBe("LSE");
		expect(processCalls[0]?.headline).toStartWith("Shell news");
	});
});
