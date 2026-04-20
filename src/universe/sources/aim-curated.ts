import type { ConstituentRow } from "../sources.ts";

// Hand-maintained AIM whitelist.
//
// Why this is hand-curated: no free source covers the AIM All-Share
// constituent list. The iShares AIM ETF is sampled (only top holdings),
// FTSE Russell publishes the full list commercially, and LSE's own site
// is hostile to scraping. For v1 we maintain a small list of the AIM
// names we actually want to trade; add to this list when onboarding a
// new AIM strategy.
const AIM_SYMBOLS: readonly string[] = [
	"GAW", // Games Workshop
	"FDEV", // Frontier Developments
	"TET", // Treatt
	"JET2", // Jet2 plc
	"BOWL", // Hollywood Bowl
];

export async function fetchAimCurated(): Promise<ConstituentRow[]> {
	return AIM_SYMBOLS.map((symbol) => ({
		symbol,
		exchange: "AIM",
		indexSource: "aim_allshare" as const,
	}));
}
