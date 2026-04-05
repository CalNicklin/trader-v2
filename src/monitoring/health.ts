import { desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { dailySnapshots, quotesCache, strategies } from "../db/schema";
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

	// Active strategy count (non-retired)
	const activeResult = db
		.select({ count: sql<number>`count(*)` })
		.from(strategies)
		.where(ne(strategies.status, "retired"))
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
	};
}
