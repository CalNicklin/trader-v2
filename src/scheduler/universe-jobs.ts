import { getOpenPositionSymbols } from "../paper/manager.ts";
import { refreshCikMap } from "../universe/ciks/edgar-ticker-map.ts";
import { runDailyDeltaCheck } from "../universe/delta.ts";
import { ibkrHaltChecker } from "../universe/halt-checker.ts";
import { refreshInvestableUniverse } from "../universe/refresh.ts";
import { fetchCandidatesFromAllSources } from "../universe/source-aggregator.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "scheduler-jobs" });

export async function runWeeklyUniverseRefresh(): Promise<void> {
	log.info({ job: "universe_refresh_weekly" }, "Job starting");
	const start = Date.now();

	// Refresh the SEC ticker→CIK map before fetching candidates. Idempotent and
	// cheap (~10k rows, one HTTP call). Safe to run weekly. Any failure here
	// should NOT abort the refresh — US profile enrichment will just use stale
	// cached CIKs if the call flakes.
	try {
		const count = await refreshCikMap();
		log.info({ count }, "SEC CIK map refreshed");
	} catch (err) {
		log.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"CIK map refresh failed — US profile enrichment will use stale cache",
		);
	}

	const openPositions = await getOpenPositionSymbols();
	const exemptSymbols = openPositions.map((p) => `${p.symbol}:${p.exchange}`);

	// Fetch once, capture failed sources so refresh doesn't purge their rows.
	const aggregate = await fetchCandidatesFromAllSources();
	if (aggregate.failedIndexSources.length > 0) {
		log.warn(
			{ failedIndexSources: aggregate.failedIndexSources },
			"Partial universe fetch — skipping deactivation for failed sources",
		);
	}

	const result = await refreshInvestableUniverse({
		fetchCandidates: async () => aggregate.candidates,
		snapshotDate: new Date().toISOString().slice(0, 10),
		exemptSymbols,
		skipDeactivationForIndexSources: aggregate.failedIndexSources,
	});
	log.info(
		{
			job: "universe_refresh_weekly",
			durationMs: Date.now() - start,
			failedIndexSources: aggregate.failedIndexSources,
			...result,
		},
		"Job completed",
	);
}

export async function runDailyUniverseDelta(): Promise<void> {
	log.info({ job: "universe_delta_daily" }, "Job starting");
	const start = Date.now();
	const openPositions = await getOpenPositionSymbols();
	const exemptSymbols = openPositions.map((p) => `${p.symbol}:${p.exchange}`);
	const result = await runDailyDeltaCheck({
		checker: ibkrHaltChecker,
		snapshotDate: new Date().toISOString().slice(0, 10),
		exemptSymbols,
	});
	log.info(
		{ job: "universe_delta_daily", durationMs: Date.now() - start, demoted: result.demoted },
		"Job completed",
	);
}
