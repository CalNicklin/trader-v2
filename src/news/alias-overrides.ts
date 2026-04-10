// src/news/alias-overrides.ts
//
// Hand-maintained nickname aliases for FTSE-100 symbols. Merged with FMP-
// derived aliases in rss-feeds.ts at load time. Add new entries here rather
// than editing rss-feeds.ts directly.
//
// See src/news/CLAUDE.md for rationale.

export const ALIAS_OVERRIDES: Record<string, string[]> = {
	SHEL: ["Shell", "Royal Dutch Shell"],
	"BP.": ["BP", "British Petroleum"],
	HSBA: ["HSBC", "HSBC Holdings"],
	AZN: ["AstraZeneca"],
	GSK: ["GSK", "GlaxoSmithKline"],
	ULVR: ["Unilever"],
	VOD: ["Vodafone"],
	RIO: ["Rio Tinto"],
	LLOY: ["Lloyds", "Lloyds Banking Group"],
	BARC: ["Barclays"],
	NWG: ["NatWest", "NatWest Group"],
	STAN: ["Standard Chartered"],
	DGE: ["Diageo"],
	REL: ["RELX"],
	PRU: ["Prudential"],
	LGEN: ["Legal & General", "Legal and General"],
	AAL: ["Anglo American"],
	GLEN: ["Glencore"],
	CNA: ["Centrica"],
	SSE: ["SSE"],
	BT_A: ["BT Group", "BT"],
	IMB: ["Imperial Brands"],
	BATS: ["British American Tobacco", "BAT"],
	TSCO: ["Tesco"],
	SBRY: ["Sainsbury", "Sainsbury's"],
};
