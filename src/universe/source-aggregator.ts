import type { FilterCandidate } from "./filters.ts";
import { enrichWithMetrics } from "./metrics-enricher.ts";
import {
	type ConstituentRow,
	fetchAimAllShareConstituents,
	fetchFtse350Constituents,
	fetchRussell1000Constituents,
} from "./sources.ts";

export async function fetchCandidatesFromAllSources(): Promise<FilterCandidate[]> {
	const [russell, ftse, aim] = await Promise.all([
		fetchRussell1000Constituents(),
		fetchFtse350Constituents(),
		fetchAimAllShareConstituents(),
	]);
	const rows: ConstituentRow[] = [...russell, ...ftse, ...aim];
	return enrichWithMetrics(rows);
}
