#!/usr/bin/env bun
/**
 * Backfill news_events rows that have classified_at=NULL.
 *
 * When classification fails (e.g. Anthropic credit balance exhausted, network
 * outage), `storeNewsEvent` still inserts the row so we don't re-fetch the
 * same URL. But `isHeadlineSeen` then catches those rows as duplicates on
 * subsequent polls, so classification never gets retried via the normal path.
 *
 * This script:
 *  1. Finds rows with classified_at=NULL from the last N days
 *  2. Re-runs classifyHeadline() on each
 *  3. Updates the row with the classification output
 *  4. Fires the watchlist-promotion hook for tradeable results
 *     (skips research-agent — stale headlines don't deserve Sonnet spend)
 *
 * Usage:
 *   # Production run (on VPS):
 *   sudo -u deploy /home/deploy/.bun/bin/bun scripts/backfill-news-classifications.ts
 *
 *   # Dry-run (just count, no API calls):
 *   DRY_RUN=1 bun scripts/backfill-news-classifications.ts
 *
 *   # Limit lookback window (default 2 days):
 *   LOOKBACK_DAYS=7 bun scripts/backfill-news-classifications.ts
 */

const DRY_RUN = process.env.DRY_RUN === "1";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? "2");

const { getDb } = await import("../src/db/client.ts");
const { newsEvents } = await import("../src/db/schema.ts");
const { and, isNull, gte, eq } = await import("drizzle-orm");
const { classifyHeadline } = await import("../src/news/classifier.ts");
const { onTradeableClassification } = await import("../src/news/classifier.ts");
const { createChildLogger } = await import("../src/utils/logger.ts");

const log = createChildLogger({ module: "backfill-news-classifications" });

async function main() {
	const db = getDb();
	const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

	const stuck = await db
		.select()
		.from(newsEvents)
		.where(and(isNull(newsEvents.classifiedAt), gte(newsEvents.createdAt, cutoff)))
		.all();

	log.info({ count: stuck.length, lookbackDays: LOOKBACK_DAYS, dryRun: DRY_RUN }, "Stuck news_events found");

	if (stuck.length === 0) {
		console.log("Nothing to backfill. Exiting.");
		return;
	}

	if (DRY_RUN) {
		console.log(`DRY_RUN: would classify ${stuck.length} rows. Set DRY_RUN=0 (or omit) to run.`);
		// Print a sample for sanity
		for (const row of stuck.slice(0, 5)) {
			console.log(`  id=${row.id} symbols=${row.symbols} "${row.headline.slice(0, 80)}"`);
		}
		return;
	}

	let classified = 0;
	let skipped = 0;
	let tradeable = 0;
	let promoted = 0;
	let failed = 0;

	for (const row of stuck) {
		// Pick a primary symbol for classification. The symbols column is a JSON
		// array like `["AAPL"]` or `["AAPL","GOOGL"]`. Use the first.
		let symbols: string[];
		try {
			symbols = row.symbols ? (JSON.parse(row.symbols) as string[]) : [];
		} catch {
			symbols = [];
		}
		const primarySymbol = symbols[0];
		if (!primarySymbol) {
			skipped++;
			continue;
		}

		const result = await classifyHeadline(row.headline, primarySymbol);
		if (!result) {
			// Budget exhausted or API error. classifyHeadline already logged.
			failed++;
			continue;
		}

		// Update the row with the classification. Mirrors the storeNewsEvent path
		// in src/news/ingest.ts.
		await db
			.update(newsEvents)
			.set({
				sentiment: result.sentiment,
				confidence: result.confidence,
				tradeable: result.tradeable,
				eventType: result.eventType,
				urgency: result.urgency,
				classifiedAt: new Date().toISOString(),
				earningsSurprise: result.signals?.earningsSurprise ?? null,
				guidanceChange: result.signals?.guidanceChange ?? null,
				managementTone: result.signals?.managementTone ?? null,
				regulatoryRisk: result.signals?.regulatoryRisk ?? null,
				acquisitionLikelihood: result.signals?.acquisitionLikelihood ?? null,
				catalystType: result.signals?.catalystType ?? null,
				expectedMoveDuration: result.signals?.expectedMoveDuration ?? null,
			})
			.where(eq(newsEvents.id, row.id));

		classified++;
		if (result.tradeable) {
			tradeable++;
			// Fire watchlist promotion for each affected symbol. We deliberately
			// skip the research-agent (Sonnet) call — those headlines are hours
			// old and the Sonnet spend is better reserved for live flow.
			const exchange = inferExchange(symbols);
			for (const symbol of symbols) {
				try {
					await onTradeableClassification({
						newsEventId: row.id,
						symbol,
						exchange,
						classification: {
							tradeable: result.tradeable,
							urgency: result.urgency,
							sentiment: result.sentiment,
							confidence: result.confidence,
						},
						headline: row.headline,
					});
					promoted++;
				} catch (err) {
					log.warn(
						{ err: err instanceof Error ? err.message : String(err), symbol, id: row.id },
						"Watchlist promotion failed (non-fatal)",
					);
				}
			}
		}
	}

	log.info(
		{ total: stuck.length, classified, tradeable, promoted, skipped, failed },
		"Backfill complete",
	);

	console.log(`\n── Summary ──`);
	console.log(`  Stuck rows found: ${stuck.length}`);
	console.log(`  Classified: ${classified}`);
	console.log(`  Tradeable: ${tradeable}`);
	console.log(`  Watchlist promotions attempted: ${promoted}`);
	console.log(`  Skipped (no symbols): ${skipped}`);
	console.log(`  Failed (API error): ${failed}`);
}

// Infer a single exchange from a symbols list. FMP-era code passed it as
// a separate parameter; we don't store exchange on news_events so we infer.
// For US-only tickers this is NASDAQ (conservative default — most Russell
// 1000 symbols are NASDAQ-primary).
function inferExchange(symbols: string[]): string {
	const first = symbols[0] ?? "";
	// UK tickers on our curated list end with short uppercase EPIC codes.
	// Simple heuristic: if any symbol is in our known UK set, treat as LSE.
	const UK_KNOWN = new Set([
		"HSBA", "AZN", "SHEL", "RR", "BP", "ULVR", "BATS", "GSK", "RIO", "BA",
		"GAW", "FDEV", "TET", "JET2", "BOWL", "VOD",
	]);
	if (UK_KNOWN.has(first)) return "LSE";
	return "NASDAQ";
}

await main();
