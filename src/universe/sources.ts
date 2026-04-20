// Type declarations for universe sources. The concrete fetchers live in
// src/universe/sources/ and are wired through src/universe/source-aggregator.ts.
// This file used to also host FMP-based fetchers (Russell, FTSE, AIM); those
// were removed during FMP removal — see git history (pre-April 2026).

export interface ConstituentRow {
	symbol: string;
	exchange: string;
	indexSource: "russell_1000" | "ftse_350" | "aim_allshare";
}

export type FetchLike = (
	url: string,
) => Promise<Pick<Response, "ok" | "status" | "statusText" | "json">>;
