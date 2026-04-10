// tests/news/research-agent.test.ts
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { strategies } from "../../src/db/schema.ts";
import type { ResearchAnalysis } from "../../src/news/research-agent.ts";
import {
	_test_filterAndPin,
	buildResearchPrompt,
	buildUniverseWhitelist,
	parseResearchResponse,
} from "../../src/news/research-agent.ts";

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
		const prompt = buildResearchPrompt(
			{
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
			},
			{ whitelist: [], primaryExchange: "NASDAQ" },
		);

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

describe("buildUniverseWhitelist", () => {
	beforeEach(async () => {
		const db = getDb();
		await db.delete(strategies).where(eq(strategies.createdBy, "test"));
	});

	it("returns deduped {symbol, exchange} pairs from all paper strategies", async () => {
		const db = getDb();
		await db.insert(strategies).values([
			{
				name: "t1",
				description: "test",
				parameters: "{}",
				universe: JSON.stringify(["SHEL:LSE", "BP.:LSE", "AAPL"]),
				status: "paper",
				createdBy: "test",
			},
			{
				name: "t2",
				description: "test",
				parameters: "{}",
				universe: JSON.stringify(["SHEL:LSE", "MSFT"]),
				status: "paper",
				createdBy: "test",
			},
		]);

		const whitelist = await buildUniverseWhitelist();
		const keys = new Set(whitelist.map((w) => `${w.symbol}:${w.exchange}`));
		expect(keys.has("SHEL:LSE")).toBe(true);
		expect(keys.has("BP.:LSE")).toBe(true);
		expect(keys.has("AAPL:NASDAQ")).toBe(true);
		expect(keys.has("MSFT:NASDAQ")).toBe(true);
		// deduped
		expect(whitelist.filter((w) => w.symbol === "SHEL" && w.exchange === "LSE").length).toBe(1);
	});

	it("ignores non-paper strategies", async () => {
		const db = getDb();
		await db.insert(strategies).values({
			name: "t3",
			description: "test",
			parameters: "{}",
			universe: JSON.stringify(["EXCLUDED:LSE"]),
			status: "retired",
			createdBy: "test",
		});
		const whitelist = await buildUniverseWhitelist();
		expect(whitelist.find((w) => w.symbol === "EXCLUDED")).toBeUndefined();
	});
});

describe("buildResearchPrompt whitelist", () => {
	const input = {
		headline: "Shell plc raises dividend",
		source: "Sharecast",
		symbols: ["SHEL"],
		classification: {
			sentiment: 0.4,
			confidence: 0.8,
			tradeable: true,
			eventType: "dividend",
			urgency: "medium",
		},
	};
	const whitelist = [
		{ symbol: "SHEL", exchange: "LSE" },
		{ symbol: "BP.", exchange: "LSE" },
	];

	it("includes the whitelist in the prompt with separated symbol and exchange", () => {
		const prompt = buildResearchPrompt(input, { whitelist, primaryExchange: "LSE" });
		expect(prompt).toContain("Tradeable universe");
		expect(prompt).toContain("- SHEL (exchange: LSE)");
		expect(prompt).toContain("- BP. (exchange: LSE)");
		expect(prompt).not.toContain("SHEL:LSE");
	});

	it("includes the primary symbol pin instruction with separated fields", () => {
		const prompt = buildResearchPrompt(input, { whitelist, primaryExchange: "LSE" });
		expect(prompt).toContain("Primary attribution");
		expect(prompt).toContain(`symbol="SHEL"`);
		expect(prompt).toContain(`exchange="LSE"`);
	});
});

describe("filterAndPin", () => {
	const whitelist = [
		{ symbol: "SHEL", exchange: "LSE" },
		{ symbol: "BP.", exchange: "LSE" },
		{ symbol: "AAPL", exchange: "NASDAQ" },
	];

	it("drops symbols not in the whitelist", () => {
		const analyses: ResearchAnalysis[] = [
			{
				symbol: "SHEL",
				exchange: "LSE",
				sentiment: 0.5,
				urgency: "medium",
				eventType: "dividend",
				direction: "long",
				tradeThesis: "Dividend raised",
				confidence: 0.8,
				recommendTrade: true,
			},
			{
				symbol: "PANASONIC",
				exchange: "LSE",
				sentiment: 0.1,
				urgency: "low",
				eventType: "mention",
				direction: "long",
				tradeThesis: "Mentioned",
				confidence: 0.5,
				recommendTrade: false,
			},
		];
		const result = _test_filterAndPin(analyses, "SHEL", "LSE", whitelist);
		expect(result.map((a) => a.symbol)).toEqual(["SHEL"]);
	});

	it("re-inserts the primary symbol with neutralised signal if the LLM drops it", () => {
		const analyses: ResearchAnalysis[] = [
			{
				symbol: "BP.",
				exchange: "LSE",
				sentiment: 0.3,
				urgency: "medium",
				eventType: "dividend",
				direction: "long",
				tradeThesis: "Benefits from sector mood",
				confidence: 0.7,
				recommendTrade: true,
			},
		];
		const result = _test_filterAndPin(analyses, "SHEL", "LSE", whitelist);
		const shel = result.find((a) => a.symbol === "SHEL");
		expect(shel).toBeDefined();
		expect(shel?.direction).toBe("avoid");
		expect(shel?.confidence).toBe(0.5);
		expect(shel?.recommendTrade).toBe(false);
	});

	it("does not pin if the primary symbol is outside the whitelist", () => {
		const analyses: ResearchAnalysis[] = [];
		const result = _test_filterAndPin(analyses, "NOTINLIST", "LSE", whitelist);
		expect(result).toEqual([]);
	});

	it("respects RESEARCH_WHITELIST_ENFORCE=false kill switch", () => {
		process.env.RESEARCH_WHITELIST_ENFORCE = "false";
		try {
			const analyses: ResearchAnalysis[] = [
				{
					symbol: "PANASONIC",
					exchange: "LSE",
					sentiment: 0.1,
					urgency: "low",
					eventType: "mention",
					direction: "long",
					tradeThesis: "Mentioned",
					confidence: 0.5,
					recommendTrade: false,
				},
			];
			const result = _test_filterAndPin(analyses, "PANASONIC", "LSE", whitelist);
			expect(result.map((a) => a.symbol)).toEqual(["PANASONIC"]);
		} finally {
			delete process.env.RESEARCH_WHITELIST_ENFORCE;
		}
	});
});
