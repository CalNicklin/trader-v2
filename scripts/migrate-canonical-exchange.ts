// scripts/migrate-canonical-exchange.ts
// Idempotent. Re-resolves canonical exchange for every distinct symbol in
// news_analyses + quotes_cache and rewrites rows where the stored exchange
// disagrees with FMP /profile. Handles unique-index collisions via merge.

import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client.ts";
import { fmpResolveExchange } from "../src/data/fmp.ts";

async function main(): Promise<void> {
	const db = getDb();

	const symbolsRows = await db.all<{ symbol: string }>(
		sql`SELECT DISTINCT symbol FROM news_analyses`,
	);
	const symbols = symbolsRows.map((r) => r.symbol);
	console.log(`Resolving canonical exchange for ${symbols.length} symbols...`);

	const canonical = new Map<string, string>();
	for (const sym of symbols) {
		const ex = await fmpResolveExchange(sym);
		if (ex) {
			canonical.set(sym, ex);
		} else {
			console.warn(`SKIP: could not resolve exchange for ${sym}`);
		}
	}

	let analysesUpdated = 0;
	let analysesSkipped = 0;
	for (const [symbol, exchange] of canonical) {
		// Find rows whose exchange differs from canonical
		const rows = await db.all<{
			id: number;
			exchange: string;
			news_event_id: number;
		}>(
			sql`SELECT id, exchange, news_event_id FROM news_analyses
			    WHERE symbol = ${symbol} AND exchange != ${exchange}`,
		);
		for (const row of rows) {
			// Check if a canonical-exchange row already exists for this event+symbol
			const collision = await db.all<{ id: number }>(
				sql`SELECT id FROM news_analyses
				    WHERE news_event_id = ${row.news_event_id}
				      AND symbol = ${symbol}
				      AND exchange = ${exchange}`,
			);
			if (collision.length > 0) {
				// Drop the off-canonical duplicate; canonical row is the survivor.
				await db.run(sql`DELETE FROM news_analyses WHERE id = ${row.id}`);
				analysesSkipped++;
			} else {
				await db.run(
					sql`UPDATE news_analyses SET exchange = ${exchange} WHERE id = ${row.id}`,
				);
				analysesUpdated++;
			}
		}
	}

	let quotesUpdated = 0;
	let quotesDeleted = 0;
	for (const [symbol, exchange] of canonical) {
		const rows = await db.all<{ id: number; exchange: string }>(
			sql`SELECT id, exchange FROM quotes_cache
			    WHERE symbol = ${symbol} AND exchange != ${exchange}`,
		);
		for (const row of rows) {
			const collision = await db.all<{ id: number }>(
				sql`SELECT id FROM quotes_cache
				    WHERE symbol = ${symbol} AND exchange = ${exchange}`,
			);
			if (collision.length > 0) {
				await db.run(sql`DELETE FROM quotes_cache WHERE id = ${row.id}`);
				quotesDeleted++;
			} else {
				await db.run(
					sql`UPDATE quotes_cache SET exchange = ${exchange} WHERE id = ${row.id}`,
				);
				quotesUpdated++;
			}
		}
	}

	console.log(
		JSON.stringify(
			{
				analysesUpdated,
				analysesSkipped,
				quotesUpdated,
				quotesDeleted,
			},
			null,
			2,
		),
	);

	closeDb();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
