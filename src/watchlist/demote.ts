import { eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse, paperPositions, watchlist } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import {
	type DemotionReason,
	ENRICHMENT_DEMOTION_HOURS,
	STALENESS_HOURS,
	WATCHLIST_CAP_SOFT,
} from "./constants.ts";
import { rankForCapEviction } from "./filters.ts";
import { getActiveWatchlist, type WatchlistRow } from "./repo.ts";

const log = createChildLogger({ module: "watchlist-demote" });

export interface DemotionResult {
	scanned: number;
	demoted: number;
	byReason: Record<string, number>;
}

/**
 * TRA-41: when `exchanges` is set, the sweep operates only on rows in those
 * exchanges (both rule-based and cap-eviction). `cap` overrides the global
 * `WATCHLIST_CAP_SOFT`. Production runs this twice — once for UK shortly
 * after LSE close, once for US after the US session — so cap-eviction ranks
 * each region against same-region peers without timezone bias.
 */
export interface RunDemotionOpts {
	exchanges?: readonly string[];
	cap?: number;
}

export async function runDemotionSweep(
	now: Date,
	opts: RunDemotionOpts = {},
): Promise<DemotionResult> {
	const db = getDb();
	const allRows = getActiveWatchlist();
	const rows = opts.exchanges
		? allRows.filter((r) => opts.exchanges!.includes(r.exchange))
		: allRows;
	const cap = opts.cap ?? WATCHLIST_CAP_SOFT;
	const result: DemotionResult = { scanned: rows.length, demoted: 0, byReason: {} };

	// Open paper positions: closedAt IS NULL — these symbols must never be demoted.
	const openPositions = db
		.select()
		.from(paperPositions)
		.where(isNull(paperPositions.closedAt))
		.all();
	const openKeys = new Set(openPositions.map((p) => `${p.symbol}:${p.exchange}`));

	const activeUniverseRows = db
		.select({ symbol: investableUniverse.symbol, exchange: investableUniverse.exchange })
		.from(investableUniverse)
		.where(eq(investableUniverse.active, true))
		.all();
	const activeUniverseKeys = new Set(activeUniverseRows.map((r) => `${r.symbol}:${r.exchange}`));

	const survivors: WatchlistRow[] = [];

	for (const row of rows) {
		const key = `${row.symbol}:${row.exchange}`;
		if (openKeys.has(key)) {
			survivors.push(row);
			continue;
		}

		const reason = evaluateRules(row, now, activeUniverseKeys);
		if (reason) {
			await demoteRow(row.id, reason, now);
			result.demoted++;
			result.byReason[reason] = (result.byReason[reason] ?? 0) + 1;
		} else {
			survivors.push(row);
		}
	}

	if (survivors.length > cap) {
		const ranked = rankForCapEviction(survivors);
		const toEvict = ranked.slice(cap);
		for (const row of toEvict) {
			if (openKeys.has(`${row.symbol}:${row.exchange}`)) continue;
			await demoteRow(row.id, "cap_eviction", now);
			result.demoted++;
			result.byReason.cap_eviction = (result.byReason.cap_eviction ?? 0) + 1;
		}
	}

	log.info(
		{ ...result, scope: opts.exchanges ?? "all", cap },
		"Demotion sweep complete",
	);
	return result;
}

function evaluateRules(
	row: WatchlistRow,
	now: Date,
	activeUniverseKeys: Set<string>,
): DemotionReason | null {
	const nowMs = now.getTime();
	const lastCatalystMs = Date.parse(row.lastCatalystAt);
	const ageHours = (nowMs - lastCatalystMs) / 3600_000;

	// Rule 1: staleness
	if (ageHours > STALENESS_HOURS) return "stale";

	// Rule 2: catalyst resolved (LLM flag)
	if (row.researchPayload) {
		try {
			const payload = JSON.parse(row.researchPayload);
			if (payload?.status === "resolved") return "resolved";
		} catch {
			// Malformed payload — ignore; enrichment will retry or mark failed.
		}
	}

	// Rule 3 (volume collapse) and Rule 6 (position-closed + idle) are
	// intentionally deferred. Rule 3 requires multi-session rolling volume
	// data not currently surfaced from quotes_cache; Rule 6 requires a
	// position-close event stream. The 72h staleness rule (Rule 1) catches
	// the same symbols in both cases during v1.

	// Rule 4: removed from investable_universe
	if (!activeUniverseKeys.has(`${row.symbol}:${row.exchange}`)) return "universe_removed";

	// Rule 5: learning-loop demote flag
	if (row.researchPayload) {
		try {
			const payload = JSON.parse(row.researchPayload);
			if (payload?.learning_demote === true) return "feedback_demote";
		} catch {
			// already handled
		}
	}

	// Rule 7: enrichment permanently failed > 48h ago
	if (row.enrichmentFailedAt) {
		const failedAgeHours = (nowMs - Date.parse(row.enrichmentFailedAt)) / 3600_000;
		if (failedAgeHours > ENRICHMENT_DEMOTION_HOURS) return "enrichment_failed";
	}

	return null;
}

async function demoteRow(id: number, reason: DemotionReason, now: Date): Promise<void> {
	getDb()
		.update(watchlist)
		.set({
			demotedAt: now.toISOString(),
			demotionReason: reason,
		})
		.where(eq(watchlist.id, id))
		.run();
}
