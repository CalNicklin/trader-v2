import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";

/**
 * AI-Semi Supply Chain Observation Tier (TRA-11).
 *
 * A fixed 13-symbol basket that is observed (not traded) whenever a bellwether
 * or hyperscaler catalyst fires. Hit-rate is measured at T+5 trading days
 * against a pre-registered ≥55% threshold for moves ≥ +2%. See the design
 * spec at `docs/superpowers/specs/2026-04-23-ai-semi-observation-tier-design.md`.
 */

export const AI_SEMI_SUPPLYCHAIN_BASKET = [
	"AVGO",
	"MRVL",
	"TSM",
	"ASML",
	"AMAT",
	"KLAC",
	"LRCX",
	"SMCI",
	"MU",
	"WDC",
	"ANET",
	"ADI",
	"INTC",
] as const;

/**
 * Symbols whose high-urgency tradeable news counts as a gate-fire for the
 * AI-semi tier. NVDA / AVGO are bellwether; hyperscalers are the demand
 * side whose capex guidance moves the whole basket.
 */
export const AI_SEMI_GATE_TRIGGERS: ReadonlySet<string> = new Set([
	"NVDA",
	"AVGO",
	"AMZN",
	"MSFT",
	"GOOGL",
	"META",
]);

export const AI_SEMI_GATE_NAME = "ai_semi_supplychain_v1";

/** Hit threshold: basket avg move ≥ +2% (i.e. 0.02) at T+5 trading days. */
export const AI_SEMI_HIT_THRESHOLD_PCT = 0.02;

/** Fallback cut-off: measurement rows older than this without prices get
 *  sentinel-closed so the sweep doesn't retry forever. Mirrors the spec. */
export const AI_SEMI_SENTINEL_AFTER_DAYS = 7;

export interface GateFireContext {
	triggerSymbol: string;
	triggerNewsEventId: number;
	/** Must be `tradeable = true` AND `urgency = 'high'` at the classifier. */
	tradeable: boolean;
	urgency: "low" | "medium" | "high" | null;
}

/**
 * Returns true iff the incoming classified news event qualifies as a gate
 * fire. Pure function — tests don't need the DB.
 */
export function shouldFireAiSemiGate(ctx: GateFireContext): boolean {
	if (!ctx.tradeable) return false;
	if (ctx.urgency !== "high") return false;
	if (!AI_SEMI_GATE_TRIGGERS.has(ctx.triggerSymbol)) return false;
	return true;
}

/**
 * Snapshot the current cached price for each basket symbol. Symbols with no
 * price row (or a null price) are recorded as `null` — we log what we have.
 * Keeps I/O to a single `WHERE symbol IN (…)` query regardless of basket size.
 */
export async function snapshotBasket(): Promise<Record<string, number | null>> {
	const db = getDb();
	const rows = await db
		.select({ symbol: quotesCache.symbol, last: quotesCache.last })
		.from(quotesCache)
		.where(
			inArray(quotesCache.symbol, AI_SEMI_SUPPLYCHAIN_BASKET as readonly string[] as string[]),
		);

	const priceBySymbol = new Map<string, number | null>();
	for (const row of rows) {
		priceBySymbol.set(row.symbol, row.last);
	}

	const snapshot: Record<string, number | null> = {};
	for (const symbol of AI_SEMI_SUPPLYCHAIN_BASKET) {
		snapshot[symbol] = priceBySymbol.get(symbol) ?? null;
	}
	return snapshot;
}

/**
 * Compute the average percentage move from fire-time snapshot to
 * measurement-time snapshot. Uses the symbols that have non-null prices in
 * both snapshots; returns null if none overlap (caller should quarantine).
 */
export function computeAvgMovePct(
	snapshotAtFire: Record<string, number | null>,
	snapshotAt5d: Record<string, number | null>,
): number | null {
	let sum = 0;
	let count = 0;
	for (const symbol of AI_SEMI_SUPPLYCHAIN_BASKET) {
		const p0 = snapshotAtFire[symbol];
		const p1 = snapshotAt5d[symbol];
		if (p0 == null || p1 == null || p0 <= 0) continue;
		sum += (p1 - p0) / p0;
		count++;
	}
	if (count === 0) return null;
	return sum / count;
}

/** Whether the measured move clears the pre-registered hit threshold. */
export function meetsHitThreshold(avgMovePct: number | null): boolean {
	if (avgMovePct == null) return false;
	return avgMovePct >= AI_SEMI_HIT_THRESHOLD_PCT;
}
