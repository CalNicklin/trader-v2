import { createChildLogger } from "../../utils/logger.ts";
import { getCiksForSymbols } from "../ciks/edgar-ticker-map.ts";
import type { ConstituentRow } from "../sources.ts";
import {
	type FramesQuarter,
	fetchSharesOutstandingFrames,
	mostRecentCompletedQuarter,
} from "./edgar-shares-frames.ts";
import { fetchYahooUsQuotes, type YahooUsQuote } from "./yahoo-us.ts";

const log = createChildLogger({ module: "us-profile-composer" });

export interface UsProfile {
	symbol: string;
	exchange: string;
	sharesOutstanding: number | null;
	priceUsd: number | null;
	marketCapUsd: number | null;
	avgVolume30d: number | null;
	avgDollarVolumeUsd: number | null;
	ipoDate: string | null;
}

export interface UsProfileDeps {
	getCiks?: (refs: Array<{ symbol: string; exchange: string }>) => Promise<Map<string, number>>;
	getSharesFrames?: (quarter: FramesQuarter) => Promise<Map<number, number>>;
	getYahooQuotes?: (rows: ConstituentRow[]) => Promise<Map<string, YahooUsQuote>>;
	now?: Date;
}

// Composes three free data sources into a single profile map for US rows:
//   1. SEC EDGAR company_tickers.json → ticker→CIK map (cached in symbol_ciks)
//   2. SEC EDGAR /api/xbrl/frames/ → sharesOutstanding per CIK for a quarter
//   3. Yahoo v8 chart → current price + firstTradeDate (IPO proxy) + 30d $ADV
//
// marketCapUsd = sharesOutstanding × priceUsd (computed client-side).
// If the frames call fails, marketCapUsd is null but the Yahoo-derived fields
// (price, $ADV, IPO) are still populated — US rows still pass the liquidity
// filter on price + avgDollarVolume.
export async function fetchUsProfiles(
	rows: ConstituentRow[],
	deps: UsProfileDeps = {},
): Promise<Map<string, UsProfile>> {
	const usRows = rows.filter((r) => r.exchange === "NASDAQ" || r.exchange === "NYSE");
	if (usRows.length === 0) return new Map();

	const getCiks = deps.getCiks ?? getCiksForSymbols;
	const getShares =
		deps.getSharesFrames ?? ((q: FramesQuarter) => fetchSharesOutstandingFrames({ quarter: q }));
	const getYahoo = deps.getYahooQuotes ?? fetchYahooUsQuotes;
	const now = deps.now ?? new Date();

	const quarter = mostRecentCompletedQuarter(now);

	// Fetch in parallel — each source is independent. Shares-frames is
	// non-critical (Yahoo still gives us price + $ADV which is enough for
	// the liquidity filter), so swallow its errors here to keep the
	// enrichment going.
	const [cikMap, sharesMap, yahooMap] = await Promise.all([
		getCiks(usRows.map((r) => ({ symbol: r.symbol, exchange: r.exchange }))),
		getShares(quarter).catch((err) => {
			log.warn(
				{ err: err instanceof Error ? err.message : String(err), quarter },
				"Shares frames fetch failed — marketCap will be null",
			);
			return new Map<number, number>();
		}),
		getYahoo(usRows),
	]);

	const out = new Map<string, UsProfile>();
	for (const row of usRows) {
		const key = `${row.symbol}:${row.exchange}`;
		const cik = cikMap.get(key);
		const shares = cik != null ? (sharesMap.get(cik) ?? null) : null;
		const yq = yahooMap.get(key);
		const marketCap = shares != null && yq?.priceUsd != null ? shares * yq.priceUsd : null;
		out.set(key, {
			symbol: row.symbol,
			exchange: row.exchange,
			sharesOutstanding: shares,
			priceUsd: yq?.priceUsd ?? null,
			marketCapUsd: marketCap,
			avgVolume30d: yq?.avgVolume30d ?? null,
			avgDollarVolumeUsd: yq?.avgDollarVolumeUsd ?? null,
			ipoDate: yq?.ipoDate ?? null,
		});
	}

	log.info(
		{
			requested: usRows.length,
			withShares: [...out.values()].filter((v) => v.sharesOutstanding != null).length,
			withPrice: [...out.values()].filter((v) => v.priceUsd != null).length,
			quarter,
		},
		"US profiles composed",
	);
	return out;
}
