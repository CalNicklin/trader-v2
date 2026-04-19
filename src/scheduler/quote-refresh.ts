import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { fmpBatchQuotes } from "../data/fmp.ts";
import { upsertQuote } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { newsEvents, quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "quote-refresh" });

const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Return symbols from the cache, optionally scoped to specific exchanges */
export async function getSymbolsToRefresh(
	exchanges?: Exchange[],
): Promise<Array<{ symbol: string; exchange: string }>> {
	const db = getDb();
	if (exchanges && exchanges.length > 0) {
		return db
			.select({ symbol: quotesCache.symbol, exchange: quotesCache.exchange })
			.from(quotesCache)
			.where(inArray(quotesCache.exchange, exchanges));
	}
	return db
		.select({ symbol: quotesCache.symbol, exchange: quotesCache.exchange })
		.from(quotesCache);
}

/** Refresh quotes for all symbols currently in the cache using FMP batch endpoint */
export async function refreshQuotesForAllCached(exchanges?: Exchange[]): Promise<void> {
	const cached = await getSymbolsToRefresh(exchanges);

	if (cached.length === 0) {
		log.info("No symbols in quotes cache — nothing to refresh");
		return;
	}

	const batchResults = await fmpBatchQuotes(cached);

	let refreshed = 0;
	for (const [_symbol, quote] of batchResults) {
		if (quote.last != null) {
			await upsertQuote(quote);
			refreshed++;
		}
	}

	const { markPositionsToMarket } = await import("../paper/manager.ts");
	const marked = await markPositionsToMarket();

	await backfillSentimentPrices();
	await pruneDeadSymbols();
	log.info({ total: cached.length, refreshed, positionsMarked: marked }, "Quote refresh complete");
}

/** Delete quotesCache rows with null price older than 7 days */
export async function pruneDeadSymbols(): Promise<number> {
	const db = getDb();
	const cutoff = new Date(Date.now() - PRUNE_AGE_MS).toISOString();

	const stale = await db
		.select({ id: quotesCache.id, symbol: quotesCache.symbol, exchange: quotesCache.exchange })
		.from(quotesCache)
		.where(and(isNull(quotesCache.last), lt(quotesCache.updatedAt, cutoff)));

	if (stale.length === 0) return 0;

	const ids = stale.map((s) => s.id);
	await db.delete(quotesCache).where(inArray(quotesCache.id, ids));

	log.info(
		{ count: stale.length, symbols: stale.map((s) => s.symbol) },
		"Pruned dead symbols from quotes cache",
	);
	return stale.length;
}

/**
 * Backfill priceAfter1d for classified news events that are >24h old
 * and haven't been backfilled yet. Piggybacks on quote refresh cycle.
 */
export async function backfillSentimentPrices(): Promise<void> {
	const db = getDb();
	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const staleEvents = await db
		.select({
			id: newsEvents.id,
			symbols: newsEvents.symbols,
		})
		.from(newsEvents)
		.where(
			and(
				isNotNull(newsEvents.priceAtClassification),
				isNull(newsEvents.priceAfter1d),
				lt(newsEvents.classifiedAt, oneDayAgo),
			),
		)
		.limit(50);

	if (staleEvents.length === 0) return;

	let filled = 0;
	for (const event of staleEvents) {
		const symbols: string[] = JSON.parse(event.symbols ?? "[]");
		const primarySymbol = symbols[0];
		if (!primarySymbol) continue;

		const [cached] = await db
			.select({ last: quotesCache.last })
			.from(quotesCache)
			.where(eq(quotesCache.symbol, primarySymbol))
			.limit(1);

		if (cached?.last != null) {
			await db
				.update(newsEvents)
				.set({ priceAfter1d: cached.last })
				.where(eq(newsEvents.id, event.id));
			filled++;
		}
	}

	if (filled > 0) {
		log.info(
			{ filled, total: staleEvents.length },
			"Backfilled priceAfter1d for sentiment validation",
		);
	}
}

/**
 * One-time cleanup of dead symbols. Deletes quotesCache rows where
 * last IS NULL and the symbol is not in any strategy universe or position.
 */
export async function cleanupDeadSymbols(): Promise<number> {
	const db = getDb();
	const { strategies, paperPositions } = await import("../db/schema.ts");

	// Collect all symbols in strategy universes
	const allStrategies = await db.select({ universe: strategies.universe }).from(strategies);

	const universeSymbols = new Set<string>();
	for (const s of allStrategies) {
		try {
			const universe: string[] = JSON.parse(s.universe ?? "[]");
			for (const u of universe) {
				const sym = u.includes(":") ? u.split(":")[0]! : u;
				universeSymbols.add(sym);
			}
		} catch {}
	}

	// Collect symbols with open paper positions (no closedAt = still open)
	const openPositions = await db
		.select({ symbol: paperPositions.symbol })
		.from(paperPositions)
		.where(isNull(paperPositions.closedAt));

	for (const p of openPositions) {
		universeSymbols.add(p.symbol);
	}

	// Find dead symbols not in any universe/position
	const deadRows = await db
		.select({ id: quotesCache.id, symbol: quotesCache.symbol, exchange: quotesCache.exchange })
		.from(quotesCache)
		.where(isNull(quotesCache.last));

	const toDelete = deadRows.filter((r) => !universeSymbols.has(r.symbol));
	if (toDelete.length === 0) return 0;

	const ids = toDelete.map((r) => r.id);
	await db.delete(quotesCache).where(inArray(quotesCache.id, ids));

	log.info(
		{ count: toDelete.length, symbols: toDelete.map((s) => s.symbol) },
		"One-time cleanup: removed dead symbols from quotes cache",
	);
	return toDelete.length;
}
