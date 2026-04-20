import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import { symbolCiks } from "../../db/schema.ts";
import { createChildLogger } from "../../utils/logger.ts";

const log = createChildLogger({ module: "edgar-ticker-map" });

// SEC requires a descriptive User-Agent per their rate-limit/fair-use policy.
const EDGAR_UA = "trader-v2 (cal@nicklin.io)";
const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

export interface RefreshCikMapInput {
	fetchImpl?: typeof fetch;
}

export async function refreshCikMap(input: RefreshCikMapInput = {}): Promise<number> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const res = await fetchImpl(COMPANY_TICKERS_URL, {
		headers: { "User-Agent": EDGAR_UA },
	});
	if (!res.ok) {
		throw new Error(`SEC company_tickers request failed: ${res.status}`);
	}
	const data = (await res.json()) as Record<
		string,
		{ cik_str: number; ticker: string; title: string }
	>;

	const db = getDb();
	const now = new Date().toISOString();
	let count = 0;

	// SEC's file doesn't report which exchange each ticker lives on, so we store
	// both NASDAQ and NYSE variants. The active-universe row's `exchange` field
	// determines which we look up. The lookup may match the wrong exchange for
	// e.g. NYSE-only names; we accept that as tolerable noise because Russell
	// 1000 is dominated by NASDAQ-primary names and a cross-listed symbol
	// resolves to the same CIK anyway.
	for (const entry of Object.values(data)) {
		for (const exchange of ["NASDAQ", "NYSE"]) {
			await db
				.insert(symbolCiks)
				.values({
					symbol: entry.ticker,
					exchange,
					cik: entry.cik_str,
					entityName: entry.title,
					source: "sec_company_tickers",
					fetchedAt: now,
				})
				.onConflictDoUpdate({
					target: [symbolCiks.symbol, symbolCiks.exchange],
					set: { cik: entry.cik_str, entityName: entry.title, fetchedAt: now },
				});
		}
		count++;
	}
	log.info({ count }, "CIK map refreshed");
	return count;
}

export async function getCikForSymbol(symbol: string, exchange: string): Promise<number | null> {
	const db = getDb();
	const row = await db
		.select({ cik: symbolCiks.cik })
		.from(symbolCiks)
		.where(and(eq(symbolCiks.symbol, symbol), eq(symbolCiks.exchange, exchange)))
		.get();
	return row?.cik ?? null;
}

// Simple in-memory scan: symbol_ciks is ~20k rows (10k tickers × 2 exchanges),
// trivially fast to read fully and filter. Avoids the SQLite expression-tree
// complexity we hit in getProfiles (PR #39).
export async function getCiksForSymbols(
	refs: Array<{ symbol: string; exchange: string }>,
): Promise<Map<string, number>> {
	if (refs.length === 0) return new Map();
	const db = getDb();
	const all = await db.select().from(symbolCiks).all();
	const allMap = new Map(all.map((r) => [`${r.symbol}:${r.exchange}`, r.cik]));
	const out = new Map<string, number>();
	for (const ref of refs) {
		const cik = allMap.get(`${ref.symbol}:${ref.exchange}`);
		if (cik != null) out.set(`${ref.symbol}:${ref.exchange}`, cik);
	}
	return out;
}
