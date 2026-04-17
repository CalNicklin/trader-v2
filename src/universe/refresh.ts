import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { applyLiquidityFilters, type FilterCandidate } from "./filters.ts";
import { getActiveUniverseMembership } from "./repo.ts";
import { writeDailySnapshot } from "./snapshots.ts";

const log = createChildLogger({ module: "universe-refresh" });

export interface RefreshInput {
	fetchCandidates: () => Promise<FilterCandidate[]>;
	snapshotDate: string;
	// Symbols that must NOT be removed even if they fail filters (e.g. open positions).
	// Keyed as `${symbol}:${exchange}`.
	exemptSymbols?: string[];
}

export interface RefreshResult {
	added: number;
	removed: number;
	rejected: number;
}

export async function refreshInvestableUniverse(input: RefreshInput): Promise<RefreshResult> {
	const db = getDb();
	const exempt = new Set(input.exemptSymbols ?? []);

	const candidates = await input.fetchCandidates();
	const { passed, rejected } = applyLiquidityFilters(candidates);

	const previous = await getActiveUniverseMembership();
	const previousSet = new Set(previous.map((r) => `${r.symbol}:${r.exchange}`));
	const passedSet = new Set(passed.map((p) => `${p.symbol}:${p.exchange}`));

	// Upsert all passed candidates as active
	for (const p of passed) {
		await db
			.insert(investableUniverse)
			.values({
				symbol: p.symbol,
				exchange: p.exchange,
				indexSource: p.indexSource,
				marketCapUsd: p.marketCapUsd ?? null,
				avgDollarVolume: p.avgDollarVolume ?? null,
				price: p.price ?? null,
				freeFloatUsd: p.freeFloatUsd ?? null,
				spreadBps: p.spreadBps ?? null,
				listingAgeDays: p.listingAgeDays ?? null,
				active: true,
				lastRefreshed: new Date().toISOString(),
			})
			.onConflictDoUpdate({
				target: [investableUniverse.symbol, investableUniverse.exchange],
				set: {
					indexSource: p.indexSource,
					marketCapUsd: p.marketCapUsd ?? null,
					avgDollarVolume: p.avgDollarVolume ?? null,
					price: p.price ?? null,
					freeFloatUsd: p.freeFloatUsd ?? null,
					spreadBps: p.spreadBps ?? null,
					listingAgeDays: p.listingAgeDays ?? null,
					active: true,
					lastRefreshed: new Date().toISOString(),
				},
			});
	}

	// Deactivate previous entries that aren't in the new passed set and aren't exempt
	const removedSymbols: { symbol: string; exchange: string }[] = [];
	for (const prev of previous) {
		const k = `${prev.symbol}:${prev.exchange}`;
		if (passedSet.has(k) || exempt.has(k)) continue;
		await db
			.update(investableUniverse)
			.set({ active: false, lastRefreshed: new Date().toISOString() })
			.where(
				and(
					eq(investableUniverse.symbol, prev.symbol),
					eq(investableUniverse.exchange, prev.exchange),
				),
			);
		removedSymbols.push(prev);
	}

	const addedSymbols = passed.filter((p) => !previousSet.has(`${p.symbol}:${p.exchange}`));

	await writeDailySnapshot(input.snapshotDate, {
		current: passed.map((p) => ({ symbol: p.symbol, exchange: p.exchange })),
		previous,
		removalReasons: Object.fromEntries(
			removedSymbols.map((r) => [`${r.symbol}:${r.exchange}`, "filter_reject_or_delisted"]),
		),
	});

	log.info(
		{ added: addedSymbols.length, removed: removedSymbols.length, rejected: rejected.length },
		"Investable universe refresh complete",
	);

	return {
		added: addedSymbols.length,
		removed: removedSymbols.length,
		rejected: rejected.length,
	};
}
