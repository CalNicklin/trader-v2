import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { watchlist } from "../../src/db/schema.ts";
import {
	buildEnrichmentPrompt,
	enrichOne,
	parseEnrichmentResponse,
} from "../../src/watchlist/enrich.ts";
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

describe("enrichOne", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});
	afterEach(() => closeDb());

	function insert() {
		const db = getDb();
		const now = new Date().toISOString();
		const inserted = db
			.insert(watchlist)
			.values({
				symbol: "AAPL",
				exchange: "NASDAQ",
				promotionReasons: "news",
				promotedAt: now,
				lastCatalystAt: now,
				expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
			})
			.returning({ id: watchlist.id })
			.get();
		return inserted?.id ?? 0;
	}

	test("on success: writes research_payload, directional_bias, horizon, catalyst_summary, enriched_at", async () => {
		const id = insert();
		const row = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		const llm = async () =>
			JSON.stringify({
				catalyst_summary: "Strong Q2",
				directional_bias: "long",
				horizon: "days",
				status: "active",
			});
		const result = await enrichOne(row!, llm);
		expect(result.status).toBe("enriched");

		const after = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		expect(after?.catalystSummary).toBe("Strong Q2");
		expect(after?.directionalBias).toBe("long");
		expect(after?.horizon).toBe("days");
		expect(after?.enrichedAt).not.toBeNull();
		expect(JSON.parse(after?.researchPayload ?? "null").status).toBe("active");
	});

	test("on malformed LLM response: row stays unenriched (no enriched_at), returns parse_failed", async () => {
		const id = insert();
		const row = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		const llm = async () => "not json";
		const result = await enrichOne(row!, llm);
		expect(result.status).toBe("parse_failed");

		const after = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		expect(after?.enrichedAt).toBeNull();
		expect(after?.enrichmentFailedAt).toBeNull();
	});

	test("on LLM throw: returns llm_failed, row unchanged", async () => {
		const id = insert();
		const row = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		const llm = async () => {
			throw new Error("503 unavailable");
		};
		const result = await enrichOne(row!, llm);
		expect(result.status).toBe("llm_failed");

		const after = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		expect(after?.enrichedAt).toBeNull();
	});

	test("passes recent events into the prompt", async () => {
		const id = insert();
		const row = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		let seenPrompt = "";
		const llm = async (prompt: string) => {
			seenPrompt = prompt;
			return JSON.stringify({
				catalyst_summary: "x",
				directional_bias: "long",
				horizon: "days",
				status: "active",
			});
		};
		await enrichOne(row!, llm);
		expect(seenPrompt).toContain("AAPL");
		expect(seenPrompt).toContain("news");
	});
});
