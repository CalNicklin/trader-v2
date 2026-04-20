import { and, eq } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { getDb } from "../db/client.ts";
import { investableUniverse } from "../db/schema.ts";
import { getCikForSymbol } from "../universe/ciks/edgar-ticker-map.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "exchange-resolver" });

export interface ParseDeps {
	resolver?: (symbol: string) => Promise<Exchange | null>;
}

export async function parseUniverseSpec(
	spec: string,
	deps: ParseDeps = {},
): Promise<{ symbol: string; exchange: Exchange } | null> {
	if (!spec) return null;
	if (spec.includes(":")) {
		const [sym, ex] = spec.split(":");
		if (!sym || !ex) return null;
		return { symbol: sym, exchange: ex as Exchange };
	}
	const resolver = deps.resolver ?? defaultResolver;
	const exchange = await resolver(spec);
	if (!exchange) return null;
	return { symbol: spec, exchange };
}

// Default resolver: check our investable_universe first (authoritative for
// symbols we track), then fall back to SEC CIK presence as a US proxy.
// Returns null when we can't confidently classify — caller skips the spec.
async function defaultResolver(symbol: string): Promise<Exchange | null> {
	const db = getDb();
	const ticker = symbol.trim().toUpperCase();

	for (const exch of ["NASDAQ", "NYSE", "LSE", "AIM"] as const) {
		const row = await db
			.select({ exchange: investableUniverse.exchange })
			.from(investableUniverse)
			.where(and(eq(investableUniverse.symbol, ticker), eq(investableUniverse.exchange, exch)))
			.get();
		if (row) return exch as Exchange;
	}

	// SEC CIK presence = US symbol. We store CIKs under both NASDAQ and NYSE
	// keys (per edgar-ticker-map.ts), so we check NASDAQ first then NYSE.
	const cikNasdaq = await getCikForSymbol(ticker, "NASDAQ");
	if (cikNasdaq != null) return "NASDAQ" as Exchange;
	const cikNyse = await getCikForSymbol(ticker, "NYSE");
	if (cikNyse != null) return "NYSE" as Exchange;

	log.debug({ symbol }, "exchange-resolver: no match in universe or SEC map");
	return null;
}
