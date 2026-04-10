import Parser from "rss-parser";
import { getFtse100Universe } from "../data/ftse100.ts";
import { createChildLogger } from "../utils/logger.ts";
import { ALIAS_OVERRIDES } from "./alias-overrides.ts";
import type { NewsArticle } from "./finnhub.ts";
import { UK_FEEDS } from "./uk-feed-config.ts";

const log = createChildLogger({ module: "rss-feeds" });
const parser = new Parser({
	headers: { "User-Agent": "Mozilla/5.0 (compatible; TraderAgent/2.0)" },
	timeout: 10000,
});

const ALIAS_TTL_MS = 60 * 60 * 1000;
let aliasCache: { data: Record<string, string[]>; fetchedAt: number } | null = null;

export function _resetRssAliasCache(): void {
	aliasCache = null;
}

export async function loadAliases(
	options: { skipFmp?: boolean } = {},
): Promise<Record<string, string[]>> {
	if (aliasCache && Date.now() - aliasCache.fetchedAt < ALIAS_TTL_MS) {
		return aliasCache.data;
	}

	const constituents = await getFtse100Universe({ skipFmp: options.skipFmp });
	const aliases: Record<string, string[]> = {};
	for (const c of constituents) {
		aliases[c.symbol] = [...c.aliases];
	}
	for (const [sym, extra] of Object.entries(ALIAS_OVERRIDES)) {
		aliases[sym] = Array.from(new Set([...(aliases[sym] ?? []), ...extra]));
	}
	aliasCache = { data: aliases, fetchedAt: Date.now() };
	return aliases;
}

interface RssItem {
	title: string;
	link: string;
	source: string;
	pubDate: Date;
	snippet: string;
}

/**
 * Fetch articles from UK RSS feeds.
 */
async function fetchUkFeeds(maxPerFeed = 15): Promise<RssItem[]> {
	const items: RssItem[] = [];

	for (const feed of UK_FEEDS) {
		try {
			const parsed = await parser.parseURL(feed.url);
			for (const item of (parsed.items ?? []).slice(0, maxPerFeed)) {
				const pubStr = item.pubDate ?? item.isoDate;
				if (!pubStr) continue;
				const pubDate = new Date(pubStr);
				// Only last 24h
				if (Date.now() - pubDate.getTime() > 24 * 60 * 60 * 1000) continue;

				items.push({
					title: item.title ?? "",
					link: item.link ?? "",
					source: feed.name,
					pubDate,
					snippet: (item.contentSnippet ?? item.content ?? "").substring(0, 300),
				});
			}
			log.debug({ source: feed.name }, "RSS feed fetched");
		} catch (error) {
			log.warn({ source: feed.name, error }, "Failed to fetch RSS feed");
		}
	}

	return items;
}

const FINANCIAL_CONTEXT_TERMS = [
	"plc",
	"ltd",
	"holdings",
	"ftse",
	"shares",
	"stock",
	"dividend",
	"earnings",
	"ceo",
	"results",
	"trading update",
	"profit",
	"revenue",
	"guidance",
	"pre-tax",
	"interim",
	"half-year",
	"full-year",
	"agm",
	"rights issue",
	"placing",
];

function hasFinancialContext(text: string): boolean {
	const lower = text.toLowerCase();
	return FINANCIAL_CONTEXT_TERMS.some((t) => lower.includes(t));
}

const COLLISION_BLACKLIST: Record<string, string[]> = {
	SHEL: ["shell script", "shell company", "shell game", "in a shell", "seashell"],
	"BP.": ["blood pressure", "bp oil spill"],
};

function hasCollision(symbol: string, text: string): boolean {
	const phrases = COLLISION_BLACKLIST[symbol];
	if (!phrases) return false;
	const lower = text.toLowerCase();
	return phrases.some((p) => lower.includes(p));
}

// Test-only exports (prefixed with _test_ to indicate non-public)
export const _test_hasFinancialContext = hasFinancialContext;
export const _test_hasCollision = hasCollision;

/**
 * Match RSS items to a specific symbol using ticker + company name aliases.
 */
function matchArticles(items: RssItem[], symbol: string, aliases: string[]): NewsArticle[] {
	const searchTerms: string[] = [symbol.replace(".", "")];
	if (symbol.includes(".")) searchTerms.push(symbol);
	searchTerms.push(...aliases);

	const matched: NewsArticle[] = [];
	for (const item of items) {
		const text = `${item.title} ${item.snippet}`;
		if (!searchTerms.some((term) => text.toUpperCase().includes(term.toUpperCase()))) continue;
		if (!hasFinancialContext(text)) continue;
		if (hasCollision(symbol, text)) continue;

		matched.push({
			headline: item.title,
			symbols: [symbol],
			url: item.link || null,
			source: item.source,
			publishedAt: item.pubDate,
			finnhubId: null,
		});
	}
	return matched;
}

/**
 * Fetch UK news for a list of non-US symbols via RSS feeds.
 * Fetches all feeds once, then matches each symbol against the results.
 */
export async function fetchUkNewsForSymbols(
	symbols: Array<{ symbol: string; exchange: string }>,
): Promise<Map<string, NewsArticle[]>> {
	const ukSymbols = symbols.filter((s) => s.exchange !== "NASDAQ" && s.exchange !== "NYSE");
	if (ukSymbols.length === 0) return new Map();

	const aliases = await loadAliases();
	const items = await fetchUkFeeds();
	log.info(
		{ feedItems: items.length, symbols: ukSymbols.length },
		"RSS feeds fetched for UK symbols",
	);

	const result = new Map<string, NewsArticle[]>();
	for (const { symbol } of ukSymbols) {
		const symAliases = aliases[symbol] ?? [];
		const articles = matchArticles(items, symbol, symAliases);
		if (articles.length > 0) result.set(symbol, articles);
	}
	return result;
}
