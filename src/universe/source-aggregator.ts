import type { FilterCandidate } from "./filters.ts";
import { enrichWithMetrics } from "./metrics-enricher.ts";
import {
	type ConstituentRow,
	fetchAimAllShareConstituents,
	fetchFtse350Constituents,
	fetchRussell1000Constituents,
} from "./sources.ts";

export async function fetchCandidatesFromAllSources(): Promise<FilterCandidate[]> {
	// Fail-whole on partial data: if any single constituent source (Russell,
	// FTSE, or AIM) fails, the entire weekly refresh is skipped rather than
	// rebuilding the universe from partial data. This is safer because the
	// refresh deactivates symbols that aren't in the passed set — a partial
	// fetch would spuriously deactivate hundreds of names from the missing
	// index. The job-level error handler logs the failure; the next run 7
	// days later retries. If a single source fails repeatedly, that's the
	// signal to switch to Promise.allSettled with per-source validation.
	const [russell, ftse, aim] = await Promise.all([
		fetchRussell1000Constituents(),
		fetchFtse350Constituents(),
		fetchAimAllShareConstituents(),
	]);
	const rows: ConstituentRow[] = [...russell, ...ftse, ...aim];
	return enrichWithMetrics(rows);
}
