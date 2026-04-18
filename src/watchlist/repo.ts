import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { watchlist } from "../db/schema.ts";

export type WatchlistRow = typeof watchlist.$inferSelect;

export function getActiveWatchlist(): WatchlistRow[] {
	return getDb().select().from(watchlist).where(isNull(watchlist.demotedAt)).all();
}

export function getUnenrichedRows(limit: number): WatchlistRow[] {
	return getDb()
		.select()
		.from(watchlist)
		.where(
			and(
				isNull(watchlist.demotedAt),
				isNull(watchlist.enrichedAt),
				isNull(watchlist.enrichmentFailedAt),
			),
		)
		.limit(limit)
		.all();
}

export function getWatchlistByExchange(exchange: string): WatchlistRow[] {
	return getDb()
		.select()
		.from(watchlist)
		.where(and(isNull(watchlist.demotedAt), eq(watchlist.exchange, exchange)))
		.all();
}

export function countActive(): number {
	const row = getDb()
		.select({ count: sql<number>`count(*)` })
		.from(watchlist)
		.where(isNull(watchlist.demotedAt))
		.get();
	return row?.count ?? 0;
}
