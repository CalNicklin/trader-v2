import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { desc } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsAnalyses, newsEvents } from "../../src/db/schema.ts";
import { getAggregatedNewsSignal } from "../../src/news/signal-aggregator.ts";

const NOW = new Date("2026-04-10T20:00:00.000Z");

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

function minutesAgo(n: number): string {
	return new Date(NOW.getTime() - n * 60 * 1000).toISOString();
}

async function insertAnalysis(row: {
	symbol: string;
	exchange: string;
	sentiment: number;
	confidence: number;
	createdAt: string;
}): Promise<void> {
	const db = getDb();
	await db.insert(newsEvents).values({
		source: "test",
		headline: `test-${Math.random()}`,
		symbols: JSON.stringify([row.symbol]),
		sentiment: 0,
		confidence: 0,
		tradeable: true,
		eventType: "test",
		urgency: "low",
		classifiedAt: row.createdAt,
	});
	const [evt] = await db
		.select({ id: newsEvents.id })
		.from(newsEvents)
		.orderBy(desc(newsEvents.id))
		.limit(1);
	await db.insert(newsAnalyses).values({
		newsEventId: evt!.id,
		symbol: row.symbol,
		exchange: row.exchange,
		sentiment: row.sentiment,
		urgency: "low",
		eventType: "test",
		direction: "long",
		tradeThesis: "t",
		confidence: row.confidence,
		recommendTrade: false,
		inUniverse: true,
		createdAt: row.createdAt,
	});
}

describe("getAggregatedNewsSignal — sentiment", () => {
	test("returns all-null when no rows exist", async () => {
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.sentiment).toBeNull();
		expect(result.earningsSurprise).toBeNull();
		expect(result.catalystType).toBeNull();
	});

	test("single row returns its sentiment", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0.5,
			confidence: 0.8,
			createdAt: minutesAgo(0),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.sentiment).toBeCloseTo(0.5, 5);
	});

	test("confidence-weighted mean of two rows at same age", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 1,
			confidence: 0.9,
			createdAt: minutesAgo(0),
		});
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: -1,
			confidence: 0.3,
			createdAt: minutesAgo(0),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		// (1*0.9 + -1*0.3) / (0.9 + 0.3) = 0.6/1.2 = 0.5
		expect(result.sentiment).toBeCloseTo(0.5, 5);
	});

	test("exponential decay weights fresh rows more heavily than stale rows", async () => {
		// Fresh row: +1 at age 0 (decay weight = 1)
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 1,
			confidence: 1,
			createdAt: minutesAgo(0),
		});
		// Stale row: -1 at age 4h (2 half-lives, decay weight = 0.25)
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: -1,
			confidence: 1,
			createdAt: minutesAgo(240),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		// (1*1 + -1*0.25) / (1 + 0.25) = 0.75/1.25 = 0.6
		expect(result.sentiment).toBeCloseTo(0.6, 5);
	});

	test("excludes rows older than 24h window", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 1,
			confidence: 1,
			createdAt: minutesAgo(25 * 60), // 25h ago
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.sentiment).toBeNull();
	});

	test("filters by exchange", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 1,
			confidence: 1,
			createdAt: minutesAgo(0),
		});
		await insertAnalysis({
			symbol: "AZN",
			exchange: "NASDAQ",
			sentiment: -1,
			confidence: 1,
			createdAt: minutesAgo(0),
		});
		const lse = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(lse.sentiment).toBeCloseTo(1, 5);
	});
});

async function insertEvent(row: {
	symbol: string;
	sentiment: number | null;
	confidence: number;
	classifiedAt: string;
	earningsSurprise?: number | null;
	guidanceChange?: number | null;
	managementTone?: number | null;
	regulatoryRisk?: number | null;
	acquisitionLikelihood?: number | null;
	catalystType?: string | null;
	expectedMoveDuration?: string | null;
}): Promise<void> {
	const db = getDb();
	await db.insert(newsEvents).values({
		source: "test",
		headline: `ev-${Math.random()}`,
		symbols: JSON.stringify([row.symbol]),
		sentiment: row.sentiment,
		confidence: row.confidence,
		tradeable: true,
		eventType: "test",
		urgency: "low",
		classifiedAt: row.classifiedAt,
		earningsSurprise: row.earningsSurprise ?? null,
		guidanceChange: row.guidanceChange ?? null,
		managementTone: row.managementTone ?? null,
		regulatoryRisk: row.regulatoryRisk ?? null,
		acquisitionLikelihood: row.acquisitionLikelihood ?? null,
		catalystType: row.catalystType ?? null,
		expectedMoveDuration: row.expectedMoveDuration ?? null,
	});
}

describe("getAggregatedNewsSignal — sub-signals", () => {
	test("returns weighted mean of earningsSurprise", async () => {
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.5,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.8,
		});
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.1,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.2,
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.earningsSurprise).toBeCloseTo(0.5, 5);
	});

	test("null sub-signal excluded from its own denominator", async () => {
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.5,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.8,
		});
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.5,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: null, // not treated as 0
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.earningsSurprise).toBeCloseTo(0.8, 5);
	});

	test("skips events where sentiment is null (classification failed)", async () => {
		await insertEvent({
			symbol: "AZN",
			sentiment: null,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.8,
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.earningsSurprise).toBeNull();
	});

	test("symbol matching uses JSON array membership (no prefix collision)", async () => {
		await insertEvent({
			symbol: "AZNL", // distinct ticker, should not match AZN query
			sentiment: 0.5,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.8,
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.earningsSurprise).toBeNull();
	});

	test("news_events drives sub-signals, news_analyses drives sentiment (no crossover)", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0.7,
			confidence: 1,
			createdAt: minutesAgo(0),
		});
		await insertEvent({
			symbol: "AZN",
			sentiment: -0.3, // would corrupt sentiment if read from events
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.4,
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.sentiment).toBeCloseTo(0.7, 5);
		expect(result.earningsSurprise).toBeCloseTo(0.4, 5);
	});
});

describe("getAggregatedNewsSignal — categoricals and edge cases", () => {
	test("catalystType taken from the highest-weight row", async () => {
		// Older low-confidence row — loser
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.2,
			confidence: 0.4,
			classifiedAt: minutesAgo(120), // 1 half-life
			catalystType: "partnership",
		});
		// Fresh high-confidence row — winner
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.8,
			confidence: 0.9,
			classifiedAt: minutesAgo(0),
			catalystType: "earnings_beat",
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.catalystType).toBe("earnings_beat");
	});

	test("expectedMoveDuration taken from the highest-weight row", async () => {
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.2,
			confidence: 0.4,
			classifiedAt: minutesAgo(120),
			expectedMoveDuration: "1-2w",
		});
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.8,
			confidence: 0.9,
			classifiedAt: minutesAgo(0),
			expectedMoveDuration: "1-3d",
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.expectedMoveDuration).toBe("1-3d");
	});

	test("categoricals null when no news_events rows exist", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0.5,
			confidence: 0.8,
			createdAt: minutesAgo(0),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.catalystType).toBeNull();
		expect(result.expectedMoveDuration).toBeNull();
	});

	test("neutralised filterAndPin row dampens but does not flip sentiment", async () => {
		// Real positive signal
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0.8,
			confidence: 0.9,
			createdAt: minutesAgo(0),
		});
		// Neutralised pin (what filterAndPin writes when LLM drops primary)
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0,
			confidence: 0.5,
			createdAt: minutesAgo(0),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		// (0.8*0.9 + 0*0.5) / (0.9 + 0.5) = 0.72/1.4 ≈ 0.514
		expect(result.sentiment).toBeCloseTo(0.514, 2);
		expect(result.sentiment).toBeGreaterThan(0);
	});
});
