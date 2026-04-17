import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "universe-sources" });

export interface ConstituentRow {
	symbol: string;
	exchange: string;
	indexSource: "russell_1000" | "ftse_350" | "aim_allshare";
}

export type FetchLike = (
	url: string,
) => Promise<Pick<Response, "ok" | "status" | "statusText" | "json">>;

interface FmpConstituent {
	symbol: string;
	name?: string;
	sector?: string;
	exchange?: string;
}

export async function fetchRussell1000Constituents(
	fetchImpl: FetchLike = fetch,
): Promise<ConstituentRow[]> {
	const config = getConfig();
	const url = `https://financialmodelingprep.com/api/v3/russell-1000-constituent?apikey=${config.FMP_API_KEY}`;
	const res = await fetchImpl(url);
	if (!res.ok) {
		throw new Error(`FMP russell-1000 request failed: ${res.status} ${res.statusText}`);
	}
	const rows = (await res.json()) as FmpConstituent[];
	log.info({ count: rows.length }, "Russell 1000 constituents fetched");
	return rows.map((r) => ({
		symbol: r.symbol,
		exchange: r.exchange ?? "NASDAQ",
		indexSource: "russell_1000" as const,
	}));
}
