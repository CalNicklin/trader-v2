import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "universe" });

export const UNIVERSE_CAP = 50;
export const MIN_AVG_VOLUME = 500_000;

const DEFAULT_INJECTION_TTL_MS = 4 * 60 * 60 * 1000;

interface InjectedSymbol {
	symbol: string;
	exchange: string;
	expiresAt: number;
}

const injectedSymbols: InjectedSymbol[] = [];

export function validateUniverse(symbols: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const s of symbols) {
		if (!seen.has(s)) {
			seen.add(s);
			deduped.push(s);
		}
	}
	return deduped.slice(0, UNIVERSE_CAP);
}

export async function filterByLiquidity(
	symbols: string[],
	defaultExchange: string,
): Promise<string[]> {
	const db = getDb();
	const symbolNames = symbols.map((s) => (s.includes(":") ? s.split(":")[0]! : s));

	const rows = await db
		.select({
			symbol: quotesCache.symbol,
			avgVolume: quotesCache.avgVolume,
		})
		.from(quotesCache)
		.where(inArray(quotesCache.symbol, symbolNames));

	const volumeMap = new Map<string, number | null>();
	for (const row of rows) {
		volumeMap.set(row.symbol, row.avgVolume);
	}

	return symbols.filter((symbolSpec) => {
		const symbol = symbolSpec.includes(":") ? symbolSpec.split(":")[0]! : symbolSpec;
		const avgVol = volumeMap.get(symbol);
		if (avgVol === undefined || avgVol === null) return true;
		return avgVol >= MIN_AVG_VOLUME;
	});
}

export function injectSymbol(
	symbol: string,
	exchange: string,
	ttlMs: number = DEFAULT_INJECTION_TTL_MS,
): void {
	const existing = injectedSymbols.find(
		(s) => s.symbol === symbol && s.exchange === exchange,
	);
	if (existing) {
		existing.expiresAt = Date.now() + ttlMs;
		return;
	}
	injectedSymbols.push({ symbol, exchange, expiresAt: Date.now() + ttlMs });
	log.info({ symbol, exchange, ttlMs }, "Symbol injected into universe");
}

export async function getInjectedSymbols(): Promise<Array<{ symbol: string; exchange: string }>> {
	_expireInjections();
	return injectedSymbols.map(({ symbol, exchange }) => ({ symbol, exchange }));
}

export async function buildEffectiveUniverse(baseUniverse: string[]): Promise<string[]> {
	const injected = await getInjectedSymbols();
	const injectedSpecs = injected.map(({ symbol, exchange }) => `${symbol}:${exchange}`);
	const merged = [...baseUniverse, ...injectedSpecs];
	return validateUniverse(merged);
}

export function _expireInjections(): void {
	const now = Date.now();
	let i = injectedSymbols.length;
	while (i--) {
		if (injectedSymbols[i]!.expiresAt <= now) {
			injectedSymbols.splice(i, 1);
		}
	}
}

export function _clearInjections(): void {
	injectedSymbols.length = 0;
}
