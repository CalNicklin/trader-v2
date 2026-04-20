#!/usr/bin/env bun
/**
 * Re-fire watchlist promotions for tradeable news_events that were rejected
 * earlier because the symbol wasn't in investable_universe at the time.
 *
 * Happens when the backfill (or a live poll) runs while the universe is
 * partially populated, then a later refresh expands coverage. The news_events
 * rows stay classified_at != NULL so neither normal ingest nor the classified
 * backfill will re-trigger promotion.
 *
 * Strategy: find distinct tradeable symbols in the window, skip symbols that
 * already have an active watchlist row, skip symbols not in the current
 * universe, then call onTradeableClassification with the most-recent
 * qualifying headline per symbol.
 *
 * Usage:
 *   DRY_RUN=1 bun scripts/repromote-tradeable-news.ts
 *   LOOKBACK_DAYS=3 bun scripts/repromote-tradeable-news.ts
 */

const DRY_RUN = process.env.DRY_RUN === "1";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? "3");

const { getDb } = await import("../src/db/client.ts");
const { newsEvents, watchlist, investableUniverse } = await import("../src/db/schema.ts");
const { and, eq, gte, isNull } = await import("drizzle-orm");
const { onTradeableClassification } = await import("../src/news/classifier.ts");
const { createChildLogger } = await import("../src/utils/logger.ts");

const log = createChildLogger({ module: "repromote-tradeable-news" });

async function main() {
	const db = getDb();
	const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

	const rows = db
		.select()
		.from(newsEvents)
		.where(and(eq(newsEvents.tradeable, true), gte(newsEvents.classifiedAt, cutoff)))
		.all();

	const usable = rows.filter((r) => r.urgency === "medium" || r.urgency === "high");

	// Pick the most recent headline per symbol as the promotion payload
	const bySymbol = new Map<string, (typeof usable)[number]>();
	for (const row of usable) {
		let symbols: string[];
		try {
			symbols = row.symbols ? (JSON.parse(row.symbols) as string[]) : [];
		} catch {
			continue;
		}
		for (const sym of symbols) {
			const existing = bySymbol.get(sym);
			if (!existing || (row.classifiedAt ?? "") > (existing.classifiedAt ?? "")) {
				bySymbol.set(sym, row);
			}
		}
	}

	log.info(
		{ totalTradeable: rows.length, usableUrgency: usable.length, distinctSymbols: bySymbol.size },
		"Scan complete",
	);

	type Candidate = {
		symbol: string;
		exchange: string;
		row: (typeof usable)[number];
	};
	const candidates: Candidate[] = [];
	for (const [symbol, row] of bySymbol) {
		const uni = db
			.select()
			.from(investableUniverse)
			.where(and(eq(investableUniverse.symbol, symbol), eq(investableUniverse.active, true)))
			.get();
		if (!uni) continue;

		const existing = db
			.select()
			.from(watchlist)
			.where(
				and(
					eq(watchlist.symbol, symbol),
					eq(watchlist.exchange, uni.exchange),
					isNull(watchlist.demotedAt),
				),
			)
			.get();
		if (existing) continue;

		candidates.push({ symbol, exchange: uni.exchange, row });
	}

	log.info({ candidateCount: candidates.length }, "Candidates resolved");

	for (const c of candidates) {
		console.log(
			`  ${c.symbol}/${c.exchange} urgency=${c.row.urgency} "${c.row.headline.slice(0, 80)}"`,
		);
	}

	if (DRY_RUN) {
		console.log(`\nDRY_RUN: would promote ${candidates.length} symbols.`);
		return;
	}

	let promoted = 0;
	let failed = 0;
	for (const c of candidates) {
		try {
			await onTradeableClassification({
				newsEventId: c.row.id,
				symbol: c.symbol,
				exchange: c.exchange,
				classification: {
					tradeable: true,
					urgency: c.row.urgency as "low" | "medium" | "high",
					sentiment: c.row.sentiment ?? 0,
					confidence: c.row.confidence ?? 0,
				},
				headline: c.row.headline,
			});
			promoted++;
		} catch (err) {
			log.warn(
				{ err: err instanceof Error ? err.message : String(err), symbol: c.symbol },
				"Promotion failed",
			);
			failed++;
		}
	}

	console.log(`\n── Summary ──`);
	console.log(`  Scanned tradeable: ${rows.length}`);
	console.log(`  Candidates: ${candidates.length}`);
	console.log(`  Promoted: ${promoted}`);
	console.log(`  Failed: ${failed}`);
}

await main();
