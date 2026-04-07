// tests/learning/pattern-analysis-universe.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { tradeInsights } from "../../src/db/schema.ts";
import {
	getMissedOpportunityContext,
	parseUniverseSuggestions,
} from "../../src/learning/pattern-analysis.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("getMissedOpportunityContext", () => {
	test("fetches recent missed opportunities from trade_insights", async () => {
		const db = getDb();
		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "AVGO moved +4.2% after partnership announcement",
			tags: JSON.stringify(["missed_opportunity", "partnership", "AVGO"]),
			confidence: 0.85,
		});
		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "AVGO moved +3.1% after supply chain news",
			tags: JSON.stringify(["missed_opportunity", "supply_chain", "AVGO"]),
			confidence: 0.7,
		});

		const context = await getMissedOpportunityContext();
		expect(context.length).toBe(2);
		expect(context[0]).toContain("AVGO");
	});

	test("returns empty array when no missed opportunities exist", async () => {
		const context = await getMissedOpportunityContext();
		expect(context).toEqual([]);
	});
});

describe("parseUniverseSuggestions", () => {
	test("parses valid universe suggestions from JSON", () => {
		const json = JSON.stringify({
			observations: [],
			universe_suggestions: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					reason: "Appeared in 3 missed opportunities related to AI chip partnerships",
					evidence_count: 3,
				},
			],
		});

		const result = parseUniverseSuggestions(json);
		expect(result.length).toBe(1);
		expect(result[0]!.symbol).toBe("AVGO");
		expect(result[0]!.evidenceCount).toBe(3);
	});

	test("returns empty array when no suggestions present", () => {
		expect(parseUniverseSuggestions('{"observations": []}')).toEqual([]);
		expect(parseUniverseSuggestions("not json")).toEqual([]);
	});

	test("validates exchange against known set", () => {
		const json = JSON.stringify({
			universe_suggestions: [
				{ symbol: "AVGO", exchange: "NASDAQ", reason: "Good", evidence_count: 2 },
				{ symbol: "SAP", exchange: "XETRA", reason: "Bad exchange", evidence_count: 1 },
			],
		});

		const result = parseUniverseSuggestions(json);
		expect(result.length).toBe(1);
		expect(result[0]!.symbol).toBe("AVGO");
	});
});
