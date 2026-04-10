// src/data/ftse100.ts

import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { universeCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { fmpFetch } from "./fmp.ts";
import fallback from "./ftse100-fallback.json" with { type: "json" };

const log = createChildLogger({ module: "ftse100" });

const CACHE_KEY = "ftse100";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Ftse100Constituent {
	symbol: string;
	exchange: "LSE";
	companyName: string;
	aliases: string[];
}

interface FallbackShape {
	constituents: Ftse100Constituent[];
}

let inMemoryCache: { data: Ftse100Constituent[]; fetchedAt: number } | null = null;

export function _resetFtse100Cache(): void {
	inMemoryCache = null;
}

export async function getFtse100Universe(
	options: { skipFmp?: boolean } = {},
): Promise<Ftse100Constituent[]> {
	// 1. In-memory cache (process lifetime)
	if (inMemoryCache && Date.now() - inMemoryCache.fetchedAt < CACHE_TTL_MS) {
		return inMemoryCache.data;
	}

	// 2. DB cache
	try {
		const db = getDb();
		const [row] = await db
			.select()
			.from(universeCache)
			.where(eq(universeCache.key, CACHE_KEY))
			.limit(1);

		if (row && Date.now() - row.fetchedAt < CACHE_TTL_MS) {
			try {
				const data = JSON.parse(row.data) as Ftse100Constituent[];
				inMemoryCache = { data, fetchedAt: row.fetchedAt };
				return data;
			} catch (err) {
				log.warn({ err }, "Failed to parse cached FTSE-100 data — refetching");
			}
		}
	} catch (err) {
		log.warn({ err }, "FTSE-100 DB cache read failed — continuing");
	}

	// 3. FMP fetch
	if (!options.skipFmp) {
		try {
			const fresh = await fetchFromFmp();
			if (fresh.length >= 50) {
				try {
					const db = getDb();
					await db
						.insert(universeCache)
						.values({ key: CACHE_KEY, data: JSON.stringify(fresh), fetchedAt: Date.now() })
						.onConflictDoUpdate({
							target: universeCache.key,
							set: { data: JSON.stringify(fresh), fetchedAt: Date.now() },
						});
				} catch (err) {
					log.warn({ err }, "FTSE-100 DB cache write failed — continuing");
				}
				inMemoryCache = { data: fresh, fetchedAt: Date.now() };
				log.info({ count: fresh.length }, "FTSE-100 constituents refreshed from FMP");
				return fresh;
			}
			log.warn({ count: fresh.length }, "FMP returned sparse FTSE-100 data — falling back");
		} catch (err) {
			log.warn({ err }, "FMP FTSE-100 fetch failed — falling back");
		}
	}

	// 4. Fallback JSON
	const typed = fallback as unknown as FallbackShape;
	inMemoryCache = { data: typed.constituents, fetchedAt: Date.now() };
	return typed.constituents;
}

async function fetchFromFmp(): Promise<Ftse100Constituent[]> {
	type FmpRow = { symbol: string; name: string; exchange?: string };
	let rows: FmpRow[] | null = null;

	// Try primary endpoint
	rows = await fmpFetch<FmpRow[]>("/symbol/FTSE", {});

	// Try alternate if primary failed or returned empty
	if (!rows || rows.length === 0) {
		rows = await fmpFetch<FmpRow[]>("/ftse100_constituent", {});
	}

	if (!rows) return [];

	return rows.map((r) => {
		const bare = r.symbol.endsWith(".L") ? r.symbol.slice(0, -2) : r.symbol;
		return {
			symbol: bare,
			exchange: "LSE" as const,
			companyName: r.name,
			aliases: deriveAliases(r.name),
		};
	});
}

function deriveAliases(name: string): string[] {
	const cleaned = name
		.replace(/\s+plc\b/i, "")
		.replace(/\s+Holdings\b/i, "")
		.replace(/\s+Group\b/i, "")
		.trim();
	const aliases = new Set<string>();
	if (cleaned.length > 0) aliases.add(cleaned);
	aliases.add(name);
	return Array.from(aliases);
}
