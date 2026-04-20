import { createChildLogger } from "../../utils/logger.ts";
import type { ConstituentRow } from "../sources.ts";
import { fetchIsfConstituents } from "./ishares-isf.ts";
import { fetchFtse250FromWikipedia } from "./wikipedia-ftse250.ts";

const log = createChildLogger({ module: "ftse-350-combined" });

// FTSE 350 = FTSE 100 ∪ FTSE 250. We source them separately (iShares ISF
// for FTSE 100, Wikipedia for FTSE 250) and union here into a single
// aggregator-level fetcher tagged `ftse_350` — the indexSource enum
// doesn't distinguish the two sub-indices.
//
// Fail-whole at this level: if either sub-source throws, the whole
// FTSE 350 fetch fails and the aggregator's fail-partial logic (PR #36)
// keeps the existing FTSE 350 rows as-is. We do this rather than
// returning a partial list because a partial set would cause the refresh
// to deactivate every symbol from the missing half.

export interface Ftse350CombinedDeps {
	fetchIsf?: () => Promise<ConstituentRow[]>;
	fetchWiki?: () => Promise<ConstituentRow[]>;
}

export async function fetchFtse350Combined(
	deps: Ftse350CombinedDeps = {},
): Promise<ConstituentRow[]> {
	const fetchIsf = deps.fetchIsf ?? fetchIsfConstituents;
	const fetchWiki = deps.fetchWiki ?? fetchFtse250FromWikipedia;

	const [isf, wiki] = await Promise.all([fetchIsf(), fetchWiki()]);

	const dedup = new Map<string, ConstituentRow>();
	for (const r of [...isf, ...wiki]) {
		dedup.set(`${r.symbol}:${r.exchange}`, r);
	}

	log.info(
		{ total: dedup.size, isfCount: isf.length, wikiCount: wiki.length },
		"FTSE 350 combined (ISF + Wikipedia)",
	);
	return [...dedup.values()];
}
