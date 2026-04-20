import { createChildLogger } from "../utils/logger.ts";
import type { FilterCandidate } from "./filters.ts";
import { enrichWithMetrics as defaultEnrichWithMetrics } from "./metrics-enricher.ts";
import {
	type ConstituentRow,
	fetchAimAllShareConstituents as defaultFetchAim,
	fetchFtse350Constituents as defaultFetchFtse,
	fetchRussell1000Constituents as defaultFetchRussell,
} from "./sources.ts";

const log = createChildLogger({ module: "source-aggregator" });

export interface SourceAggregateResult {
	candidates: FilterCandidate[];
	failedIndexSources: string[];
}

type IndexSource = ConstituentRow["indexSource"];

// Deps kept injectable so tests don't rely on `mock.module` (which leaks
// across tests in Bun's ES-module cache).
export interface SourceAggregateDeps {
	fetchRussell?: () => Promise<ConstituentRow[]>;
	fetchFtse?: () => Promise<ConstituentRow[]>;
	fetchAim?: () => Promise<ConstituentRow[]>;
	enrichWithMetrics?: (rows: ConstituentRow[]) => Promise<FilterCandidate[]>;
}

// Fail-partial: a single failing constituent source (e.g. FTSE blocked by the
// FMP paywall) does NOT abort the whole refresh. Failed sources are returned
// in `failedIndexSources` so the refresh layer can skip deactivating symbols
// from those sources — otherwise every weekly cycle would purge UK symbols
// while FMP is blocking that endpoint. If ALL sources fail, throw: refresh
// should not proceed against an empty universe.
export async function fetchCandidatesFromAllSources(
	deps: SourceAggregateDeps = {},
): Promise<SourceAggregateResult> {
	const sources: Array<{ indexSource: IndexSource; fetcher: () => Promise<ConstituentRow[]> }> = [
		{ indexSource: "russell_1000", fetcher: deps.fetchRussell ?? defaultFetchRussell },
		{ indexSource: "ftse_350", fetcher: deps.fetchFtse ?? defaultFetchFtse },
		{ indexSource: "aim_allshare", fetcher: deps.fetchAim ?? defaultFetchAim },
	];
	const enrich = deps.enrichWithMetrics ?? defaultEnrichWithMetrics;

	const results = await Promise.allSettled(sources.map((s) => s.fetcher()));

	const rows: ConstituentRow[] = [];
	const failedIndexSources: string[] = [];

	results.forEach((r, i) => {
		const source = sources[i];
		if (!source) return;
		if (r.status === "fulfilled") {
			rows.push(...r.value);
		} else {
			failedIndexSources.push(source.indexSource);
			const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
			log.error(
				{ source: source.indexSource, err },
				"Constituent source failed — skipping this index",
			);
		}
	});

	if (failedIndexSources.length === sources.length) {
		throw new Error("All universe sources failed — aborting refresh");
	}

	return {
		candidates: await enrich(rows),
		failedIndexSources,
	};
}
