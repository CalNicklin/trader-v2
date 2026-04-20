import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
	dailySnapshots,
	investableUniverse,
	quotesCache,
	strategies,
	watchlist,
} from "../db/schema";
import { getCatalystMetrics } from "../strategy/catalyst-dispatcher";
import { getDailySpend } from "../utils/budget";

export interface HealthData {
	status: "ok" | "degraded" | "error";
	uptime: number;
	timestamp: string;
	activeStrategies: number;
	dailyPnl: number;
	apiSpendToday: number;
	lastQuoteTime: string | null;
	paused: boolean;
	ibkrConnected?: boolean;
	universe: {
		activeCount: number;
		lastRefreshed: string | null;
		bySource: { russell_1000: number; ftse_350: number; aim_allshare: number };
	};
	watchlist: {
		activeCount: number;
		byReason: Record<string, number>;
		unenrichedCount: number;
		oldestPromotionHours: number | null;
		enrichmentFailedCount: number;
	};
	catalyst: {
		dispatchesToday: number;
		capHit: boolean;
		lastDispatchedAt: string | null;
	};
}

// Module-level pause state
let _paused = false;

export function isPaused(): boolean {
	return _paused;
}

export function setPaused(paused: boolean): void {
	_paused = paused;
}

export async function getHealthData(): Promise<HealthData> {
	const db = getDb();

	// Active strategy count (non-retired, non-paused)
	const activeResult = db
		.select({ count: sql<number>`count(*)` })
		.from(strategies)
		.where(and(ne(strategies.status, "retired"), ne(strategies.status, "paused")))
		.get();
	const activeStrategies = activeResult?.count ?? 0;

	// Today's P&L from daily snapshot
	const today = new Date().toISOString().split("T")[0];
	const snapshot = db.select().from(dailySnapshots).where(eq(dailySnapshots.date, today!)).get();
	const dailyPnl = snapshot?.dailyPnl ?? 0;

	// API spend today
	const apiSpendToday = await getDailySpend();

	// Last quote update time
	const lastQuote = db
		.select({ updatedAt: quotesCache.updatedAt })
		.from(quotesCache)
		.orderBy(desc(quotesCache.updatedAt))
		.limit(1)
		.get();
	const lastQuoteTime = lastQuote?.updatedAt ?? null;

	// Determine status
	let status: "ok" | "degraded" | "error" = "ok";
	if (_paused) {
		status = "degraded";
	} else if (lastQuoteTime) {
		const lastQuoteAge = Date.now() - new Date(lastQuoteTime).getTime();
		const ONE_HOUR = 60 * 60 * 1000;
		const hour = new Date().getUTCHours();
		if (lastQuoteAge > ONE_HOUR && hour >= 8 && hour <= 21) {
			status = "degraded";
		}
	}

	let ibkrConnected: boolean | undefined;
	try {
		const { isConnected } = await import("../broker/connection.ts");
		const { getConfig } = await import("../config.ts");
		if (getConfig().LIVE_TRADING_ENABLED) {
			ibkrConnected = isConnected();
		}
	} catch {
		// Broker module not loaded
	}

	// Watchlist stats
	const wlRows = db.select().from(watchlist).where(isNull(watchlist.demotedAt)).all();

	const byReason: Record<string, number> = {};
	let unenrichedCount = 0;
	let enrichmentFailedCount = 0;
	let oldestMs: number | null = null;
	const nowMs = Date.now();
	for (const r of wlRows) {
		for (const reason of r.promotionReasons.split(",")) {
			if (reason) byReason[reason] = (byReason[reason] ?? 0) + 1;
		}
		if (r.enrichedAt == null && r.enrichmentFailedAt == null) unenrichedCount++;
		if (r.enrichmentFailedAt != null) enrichmentFailedCount++;
		const promotedMs = Date.parse(r.promotedAt);
		if (oldestMs == null || promotedMs < oldestMs) oldestMs = promotedMs;
	}

	const oldestPromotionHours = oldestMs == null ? null : (nowMs - oldestMs) / 3600_000;

	return {
		status,
		uptime: process.uptime(),
		timestamp: new Date().toISOString(),
		activeStrategies,
		dailyPnl,
		apiSpendToday,
		lastQuoteTime,
		paused: _paused,
		ibkrConnected,
		universe: await getUniverseHealth(),
		watchlist: {
			activeCount: wlRows.length,
			byReason,
			unenrichedCount,
			oldestPromotionHours,
			enrichmentFailedCount,
		},
		catalyst: getCatalystMetrics(),
	};
}

export async function getUniverseHealth(): Promise<{
	activeCount: number;
	lastRefreshed: string | null;
	bySource: { russell_1000: number; ftse_350: number; aim_allshare: number };
}> {
	const db = getDb();
	const rows = await db
		.select({
			indexSource: investableUniverse.indexSource,
			lastRefreshed: investableUniverse.lastRefreshed,
		})
		.from(investableUniverse)
		.where(eq(investableUniverse.active, true))
		.all();
	const bySource = { russell_1000: 0, ftse_350: 0, aim_allshare: 0 };
	let latest: string | null = null;
	for (const r of rows) {
		bySource[r.indexSource]++;
		if (latest == null || r.lastRefreshed > latest) latest = r.lastRefreshed;
	}
	return { activeCount: rows.length, lastRefreshed: latest, bySource };
}
