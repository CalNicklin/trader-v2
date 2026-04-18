import { describe, expect, test } from "bun:test";
import { buildEnrichmentPrompt, parseEnrichmentResponse } from "../../src/watchlist/enrich.ts";
import type { WatchlistRow } from "../../src/watchlist/repo.ts";

function fakeRow(overrides: Partial<WatchlistRow> = {}): WatchlistRow {
	const now = new Date().toISOString();
	return {
		id: 1,
		symbol: "AAPL",
		exchange: "NASDAQ",
		promotedAt: now,
		lastCatalystAt: now,
		promotionReasons: "news",
		catalystSummary: null,
		directionalBias: null,
		horizon: null,
		researchPayload: null,
		enrichedAt: null,
		enrichmentFailedAt: null,
		expiresAt: now,
		demotedAt: null,
		demotionReason: null,
		...overrides,
	} as WatchlistRow;
}

describe("buildEnrichmentPrompt", () => {
	test("includes symbol, exchange, reasons", () => {
		const prompt = buildEnrichmentPrompt(fakeRow({ promotionReasons: "news,earnings" }), []);
		expect(prompt).toContain("AAPL");
		expect(prompt).toContain("NASDAQ");
		expect(prompt).toContain("news");
		expect(prompt).toContain("earnings");
	});

	test("embeds recent catalyst payloads", () => {
		const prompt = buildEnrichmentPrompt(fakeRow(), [
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: { headline: "Apple beats Q2" },
				firedAt: new Date().toISOString(),
			},
		]);
		expect(prompt).toContain("Apple beats Q2");
	});

	test("instructs model to return JSON with specific fields", () => {
		const prompt = buildEnrichmentPrompt(fakeRow(), []);
		expect(prompt).toMatch(/catalyst_summary/);
		expect(prompt).toMatch(/directional_bias/);
		expect(prompt).toMatch(/horizon/);
		expect(prompt).toMatch(/status/);
	});
});

describe("parseEnrichmentResponse", () => {
	test("parses valid JSON envelope", () => {
		const raw = JSON.stringify({
			catalyst_summary: "Apple beat Q2 estimates",
			directional_bias: "long",
			horizon: "days",
			status: "active",
		});
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.catalystSummary).toBe("Apple beat Q2 estimates");
			expect(result.value.directionalBias).toBe("long");
			expect(result.value.horizon).toBe("days");
			expect(result.value.status).toBe("active");
		}
	});

	test("unwraps JSON embedded in markdown fence", () => {
		const raw =
			'```json\n{"catalyst_summary":"x","directional_bias":"short","horizon":"intraday","status":"active"}\n```';
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(true);
	});

	test("rejects invalid directional_bias enum", () => {
		const raw = JSON.stringify({
			catalyst_summary: "x",
			directional_bias: "sideways",
			horizon: "days",
			status: "active",
		});
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(false);
	});

	test("rejects invalid horizon enum", () => {
		const raw = JSON.stringify({
			catalyst_summary: "x",
			directional_bias: "long",
			horizon: "months",
			status: "active",
		});
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(false);
	});

	test("rejects malformed JSON", () => {
		const result = parseEnrichmentResponse("not json");
		expect(result.ok).toBe(false);
	});

	test("rejects missing required field", () => {
		const raw = JSON.stringify({
			catalyst_summary: "x",
			horizon: "days",
			status: "active",
		});
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(false);
	});
});
