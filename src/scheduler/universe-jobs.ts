import { getOpenPositionSymbols } from "../paper/manager.ts";
import { runDailyDeltaCheck } from "../universe/delta.ts";
import { ibkrHaltChecker } from "../universe/halt-checker.ts";
import { refreshInvestableUniverse } from "../universe/refresh.ts";
import { fetchCandidatesFromAllSources } from "../universe/source-aggregator.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "scheduler-jobs" });

export async function runWeeklyUniverseRefresh(): Promise<void> {
	log.info({ job: "universe_refresh_weekly" }, "Job starting");
	const start = Date.now();
	const openPositions = await getOpenPositionSymbols();
	const exemptSymbols = openPositions.map((p) => `${p.symbol}:${p.exchange}`);
	const result = await refreshInvestableUniverse({
		fetchCandidates: fetchCandidatesFromAllSources,
		snapshotDate: new Date().toISOString().slice(0, 10),
		exemptSymbols,
	});
	log.info(
		{ job: "universe_refresh_weekly", durationMs: Date.now() - start, ...result },
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
