/**
 * Sentiment → Price Correlation Analysis
 *
 * Diagnostic script that queries the DB to measure whether
 * news sentiment predicts subsequent price movement.
 *
 * Usage: bun run scripts/analyze-sentiment.ts
 */

import { and, eq, isNotNull, gte, lte } from "drizzle-orm";
import { getDb } from "../src/db/client.ts";
import { newsEvents, paperTrades } from "../src/db/schema.ts";

// ── Types ────────────────────────────────────────────────────────────────────

interface EventData {
	sentiment: number;
	confidence: number | null;
	eventType: string | null;
	priceChangePct: number;
}

// ── Pearson Correlation ───────────────────────────────────────────────────────

function pearsonCorrelation(x: number[], y: number[]): number {
	const n = x.length;
	if (n < 2) return 0;

	const meanX = x.reduce((a, b) => a + b, 0) / n;
	const meanY = y.reduce((a, b) => a + b, 0) / n;

	let num = 0;
	let denomX = 0;
	let denomY = 0;

	for (let i = 0; i < n; i++) {
		const dx = x[i] - meanX;
		const dy = y[i] - meanY;
		num += dx * dy;
		denomX += dx * dx;
		denomY += dy * dy;
	}

	const denom = Math.sqrt(denomX * denomY);
	if (denom === 0) return 0;
	return num / denom;
}

// ── Analysis Helper ───────────────────────────────────────────────────────────

function analyzeEvents(data: EventData[], label: string): void {
	console.log(`\n--- ${label} (n=${data.length}) ---`);

	if (data.length === 0) {
		console.log("  No data.");
		return;
	}

	// Direction hit rate
	const hits = data.filter((d) => {
		const sentimentSign = d.sentiment >= 0 ? 1 : -1;
		const priceSign = d.priceChangePct >= 0 ? 1 : -1;
		return sentimentSign === priceSign;
	});
	const hitRate = (hits.length / data.length) * 100;
	console.log(`  Direction hit rate: ${hitRate.toFixed(1)}% (${hits.length}/${data.length})`);

	// Sentiment strength buckets
	const buckets: Record<string, EventData[]> = {
		"strong negative (<-0.5)": [],
		"weak negative (-0.5 to 0)": [],
		"weak positive (0 to 0.5)": [],
		"strong positive (>0.5)": [],
	};

	for (const d of data) {
		if (d.sentiment < -0.5) buckets["strong negative (<-0.5)"].push(d);
		else if (d.sentiment < 0) buckets["weak negative (-0.5 to 0)"].push(d);
		else if (d.sentiment <= 0.5) buckets["weak positive (0 to 0.5)"].push(d);
		else buckets["strong positive (>0.5)"].push(d);
	}

	console.log("\n  By sentiment strength:");
	for (const [bucketName, items] of Object.entries(buckets)) {
		if (items.length === 0) {
			console.log(`    ${bucketName}: no data`);
			continue;
		}
		const avgChange = items.reduce((a, b) => a + b.priceChangePct, 0) / items.length;
		const bucketHits = items.filter((d) => {
			const sentimentSign = d.sentiment >= 0 ? 1 : -1;
			const priceSign = d.priceChangePct >= 0 ? 1 : -1;
			return sentimentSign === priceSign;
		});
		const bucketHitRate = (bucketHits.length / items.length) * 100;
		console.log(
			`    ${bucketName}: n=${items.length}, avg change=${avgChange.toFixed(2)}%, hit rate=${bucketHitRate.toFixed(1)}%`,
		);
	}

	// By event type
	const byType: Record<string, EventData[]> = {};
	for (const d of data) {
		const key = d.eventType ?? "unknown";
		if (!byType[key]) byType[key] = [];
		byType[key].push(d);
	}

	console.log("\n  By event type:");
	for (const [type, items] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
		const avgChange = items.reduce((a, b) => a + b.priceChangePct, 0) / items.length;
		const typeHits = items.filter((d) => {
			const sentimentSign = d.sentiment >= 0 ? 1 : -1;
			const priceSign = d.priceChangePct >= 0 ? 1 : -1;
			return sentimentSign === priceSign;
		});
		const typeHitRate = (typeHits.length / items.length) * 100;
		console.log(
			`    ${type}: n=${items.length}, avg change=${avgChange.toFixed(2)}%, hit rate=${typeHitRate.toFixed(1)}%`,
		);
	}

	// Confidence calibration
	const highConf = data.filter((d) => d.confidence !== null && d.confidence >= 0.8);
	const lowConf = data.filter((d) => d.confidence !== null && d.confidence < 0.6);

	console.log("\n  Confidence calibration:");
	if (highConf.length > 0) {
		const avgMoveHigh = highConf.reduce((a, b) => a + Math.abs(b.priceChangePct), 0) / highConf.length;
		console.log(`    High confidence (>=0.8): n=${highConf.length}, avg |move|=${avgMoveHigh.toFixed(2)}%`);
	} else {
		console.log("    High confidence (>=0.8): no data");
	}
	if (lowConf.length > 0) {
		const avgMoveLow = lowConf.reduce((a, b) => a + Math.abs(b.priceChangePct), 0) / lowConf.length;
		console.log(`    Low confidence (<0.6):   n=${lowConf.length}, avg |move|=${avgMoveLow.toFixed(2)}%`);
	} else {
		console.log("    Low confidence (<0.6):  no data");
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("=== Sentiment → Price Correlation Analysis ===");

const db = getDb();

// Part A — Forward-looking data (priceAfter1d populated)
const forwardRows = await db
	.select({
		sentiment: newsEvents.sentiment,
		confidence: newsEvents.confidence,
		eventType: newsEvents.eventType,
		priceAtClassification: newsEvents.priceAtClassification,
		priceAfter1d: newsEvents.priceAfter1d,
	})
	.from(newsEvents)
	.where(
		and(
			isNotNull(newsEvents.priceAtClassification),
			isNotNull(newsEvents.priceAfter1d),
			isNotNull(newsEvents.sentiment),
		),
	);

const forwardData: EventData[] = forwardRows
	.filter((r) => r.priceAtClassification! > 0)
	.map((r) => ({
		sentiment: r.sentiment!,
		confidence: r.confidence,
		eventType: r.eventType,
		priceChangePct:
			((r.priceAfter1d! - r.priceAtClassification!) / r.priceAtClassification!) * 100,
	}));

console.log(`\nPart A — Forward-looking (priceAfter1d): ${forwardData.length} events`);
if (forwardData.length > 0) {
	analyzeEvents(forwardData, "Forward-looking data");
}

// Part B — Paper trade backfill
// Find tradeable classified news events and match to paper trades within ±1h
const tradeableRows = await db
	.select({
		sentiment: newsEvents.sentiment,
		confidence: newsEvents.confidence,
		eventType: newsEvents.eventType,
		symbols: newsEvents.symbols,
		classifiedAt: newsEvents.classifiedAt,
	})
	.from(newsEvents)
	.where(
		and(
			isNotNull(newsEvents.sentiment),
			isNotNull(newsEvents.classifiedAt),
			eq(newsEvents.tradeable, true),
		),
	);

const paperData: EventData[] = [];

for (const row of tradeableRows) {
	if (!row.symbols || !row.classifiedAt) continue;

	let symbols: string[];
	try {
		symbols = JSON.parse(row.symbols);
	} catch {
		continue;
	}
	if (!Array.isArray(symbols) || symbols.length === 0) continue;

	const classifiedAt = new Date(row.classifiedAt);
	const windowStart = new Date(classifiedAt.getTime() - 60 * 60 * 1000).toISOString();
	const windowEnd = new Date(classifiedAt.getTime() + 60 * 60 * 1000).toISOString();

	for (const symbol of symbols) {
		const trades = await db
			.select({
				price: paperTrades.price,
				pnl: paperTrades.pnl,
				quantity: paperTrades.quantity,
			})
			.from(paperTrades)
			.where(
				and(
					eq(paperTrades.symbol, symbol),
					isNotNull(paperTrades.pnl),
					gte(paperTrades.createdAt, windowStart),
					lte(paperTrades.createdAt, windowEnd),
				),
			);

		for (const trade of trades) {
			if (trade.price <= 0 || trade.pnl === null) continue;
			// Rough price change: pnl / (price * qty) * 100
			const qty = trade.quantity > 0 ? trade.quantity : 10;
			const priceChangePct = (trade.pnl / (trade.price * qty)) * 100;
			paperData.push({
				sentiment: row.sentiment!,
				confidence: row.confidence,
				eventType: row.eventType,
				priceChangePct,
			});
		}
	}
}

console.log(`\nPart B — Paper trade backfill: ${paperData.length} matched trade events`);
if (paperData.length > 0) {
	analyzeEvents(paperData, "Paper trade backfill");
}

// Combined
const combined = [...forwardData, ...paperData];

if (combined.length === 0) {
	console.log(
		"\nNo data yet. Let the system run for at least 1–2 days so that:" +
			"\n  - newsEvents.priceAfter1d gets backfilled (requires quote refresh runs after 24h)" +
			"\n  - Paper trades are generated from classified news events" +
			"\n\nRe-run this script once some data has accumulated.",
	);
} else {
	console.log(`\n--- Combined (n=${combined.length}) ---`);
	analyzeEvents(combined, "Combined dataset");

	const sentiments = combined.map((d) => d.sentiment);
	const changes = combined.map((d) => d.priceChangePct);
	const r = pearsonCorrelation(sentiments, changes);

	console.log(`\nPearson r (sentiment vs price change): ${r.toFixed(4)}`);

	let interpretation: string;
	if (r > 0.3) {
		interpretation = "Moderate positive correlation — sentiment is predictive.";
	} else if (r > 0.1) {
		interpretation = "Weak positive correlation — some signal, but noisy.";
	} else if (r > -0.1) {
		interpretation = "No meaningful correlation — sentiment is not predictive yet.";
	} else {
		interpretation = "Negative correlation — sentiment may be inverting price moves.";
	}
	console.log(`Interpretation: ${interpretation}`);
}
