import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { FetchLike } from "./sources.ts";

const log = createChildLogger({ module: "universe-profile-fetcher" });

export const PROFILE_CACHE_TTL_DAYS = 30;
const FMP_PROFILE_BATCH_SIZE = 500;

export interface SymbolProfile {
	symbol: string;
	exchange: string;
	marketCapUsd: number | null;
	sharesOutstanding: number | null;
	freeFloatShares: number | null;
	ipoDate: string | null; // ISO date
	fetchedAt: string; // ISO timestamp
}

interface FmpProfile {
	symbol: string;
	mktCap?: number | null;
	sharesOutstanding?: number | null;
	floatShares?: number | null;
	ipoDate?: string | null;
	exchange?: string | null;
	exchangeShortName?: string | null;
}

export async function fetchSymbolProfiles(
	symbols: string[],
	fetchImpl: FetchLike = fetch,
): Promise<SymbolProfile[]> {
	if (symbols.length === 0) return [];
	const config = getConfig();
	const now = new Date().toISOString();
	const profiles: SymbolProfile[] = [];

	for (let i = 0; i < symbols.length; i += FMP_PROFILE_BATCH_SIZE) {
		const batch = symbols.slice(i, i + FMP_PROFILE_BATCH_SIZE);
		const url = `https://financialmodelingprep.com/api/v3/profile/${batch.join(",")}?apikey=${config.FMP_API_KEY}`;
		const res = await fetchImpl(url);
		if (!res.ok) {
			throw new Error(`FMP profile batch request failed: ${res.status} ${res.statusText}`);
		}
		const rows = (await res.json()) as FmpProfile[];
		for (const r of rows) {
			profiles.push({
				symbol: r.symbol,
				exchange: r.exchangeShortName ?? r.exchange ?? "NASDAQ",
				marketCapUsd: r.mktCap ?? null,
				sharesOutstanding: r.sharesOutstanding ?? null,
				freeFloatShares: r.floatShares ?? null,
				ipoDate: r.ipoDate ?? null,
				fetchedAt: now,
			});
		}
	}

	log.info(
		{ requested: symbols.length, returned: profiles.length },
		"FMP profile batch fetch complete",
	);
	return profiles;
}
