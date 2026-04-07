// tests/news/research-agent.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { buildResearchPrompt, parseResearchResponse } from "../../src/news/research-agent.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("buildResearchPrompt", () => {
	test("includes headline, source, symbols, and classification", () => {
		const prompt = buildResearchPrompt({
			headline: "Broadcom and Google seal five-year AI chip partnership",
			source: "finnhub",
			symbols: ["GOOGL"],
			classification: {
				sentiment: 0.2,
				confidence: 0.7,
				tradeable: true,
				eventType: "partnership",
				urgency: "low",
			},
		});

		expect(prompt).toContain("Broadcom and Google seal five-year AI chip partnership");
		expect(prompt).toContain("GOOGL");
		expect(prompt).toContain("partnership");
		expect(prompt).toContain("sentiment");
	});
});

describe("parseResearchResponse", () => {
	test("parses valid JSON response with multiple symbols", () => {
		const json = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					sentiment: 0.85,
					urgency: "high",
					event_type: "contract_win",
					direction: "long",
					trade_thesis: "Major 5-year AI chip deal signals revenue growth",
					confidence: 0.9,
				},
				{
					symbol: "GOOGL",
					exchange: "NASDAQ",
					sentiment: 0.2,
					urgency: "low",
					event_type: "partnership",
					direction: "long",
					trade_thesis: "Partnership positive but minor for Google's scale",
					confidence: 0.4,
				},
			],
		});

		const result = parseResearchResponse(json);
		expect(result.length).toBe(2);
		expect(result[0]!.symbol).toBe("AVGO");
		expect(result[0]!.confidence).toBe(0.9);
		expect(result[0]!.recommendTrade).toBe(true); // confidence >= 0.8
		expect(result[1]!.symbol).toBe("GOOGL");
		expect(result[1]!.recommendTrade).toBe(false); // confidence < 0.8
	});

	test("drops symbols with invalid exchange", () => {
		const json = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					sentiment: 0.85,
					urgency: "high",
					event_type: "contract_win",
					direction: "long",
					trade_thesis: "Good thesis",
					confidence: 0.9,
				},
				{
					symbol: "SAP",
					exchange: "XETRA",
					sentiment: 0.3,
					urgency: "low",
					event_type: "partnership",
					direction: "long",
					trade_thesis: "Minor benefit",
					confidence: 0.3,
				},
			],
		});

		const result = parseResearchResponse(json);
		expect(result.length).toBe(1);
		expect(result[0]!.symbol).toBe("AVGO");
	});

	test("clamps sentiment to [-1, 1] and confidence to [0, 1]", () => {
		const json = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AAPL",
					exchange: "NASDAQ",
					sentiment: 1.5,
					urgency: "medium",
					event_type: "earnings_beat",
					direction: "long",
					trade_thesis: "Strong earnings",
					confidence: 1.2,
				},
			],
		});

		const result = parseResearchResponse(json);
		expect(result[0]!.sentiment).toBe(1.0);
		expect(result[0]!.confidence).toBe(1.0);
	});

	test("returns empty array for malformed JSON", () => {
		expect(parseResearchResponse("not json")).toEqual([]);
		expect(parseResearchResponse("{}")).toEqual([]);
		expect(parseResearchResponse('{"affected_symbols": "not array"}')).toEqual([]);
	});

	test("validates required fields and drops incomplete entries", () => {
		const json = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					// missing sentiment, urgency, etc.
				},
				{
					symbol: "GOOGL",
					exchange: "NASDAQ",
					sentiment: 0.3,
					urgency: "low",
					event_type: "partnership",
					direction: "long",
					trade_thesis: "Valid entry",
					confidence: 0.5,
				},
			],
		});

		const result = parseResearchResponse(json);
		expect(result.length).toBe(1);
		expect(result[0]!.symbol).toBe("GOOGL");
	});
});
