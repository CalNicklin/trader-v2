import Parser from "rss-parser";
import { createChildLogger } from "../utils/logger.ts";
import type { NewsArticle } from "./finnhub.ts";
import { UK_FEEDS } from "./uk-feed-config.ts";

const log = createChildLogger({ module: "rss-feeds" });
const parser = new Parser({
	headers: { "User-Agent": "Mozilla/5.0 (compatible; TraderAgent/2.0)" },
	timeout: 10000,
});

/**
 * Static aliases mapping LSE/AIM symbols to company names for text matching.
 */
const SYMBOL_ALIASES: Record<string, string[]> = {
	SHEL: ["Shell"],
	"BP.": ["BP"],
	AZN: ["AstraZeneca"],
	GSK: ["GSK"],
	ULVR: ["Unilever"],
	HSBA: ["HSBC"],
	VOD: ["Vodafone"],
	RIO: ["Rio Tinto"],
	GAW: ["Games Workshop"],
	FDEV: ["Frontier Developments", "Frontier"],
	TET: ["Treatt"],
	JET2: ["Jet2"],
	BOWL: ["Hollywood Bowl"],
	FEVR: ["Fevertree", "Fever-Tree", "Fever Tree"],
};

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

/**
 * Match RSS items to a specific symbol using ticker + company name aliases.
 */
function matchArticles(items: RssItem[], symbol: string): NewsArticle[] {
	const searchTerms: string[] = [symbol.replace(".", "")];
	if (symbol.includes(".")) searchTerms.push(symbol);

	const aliases = SYMBOL_ALIASES[symbol];
	if (aliases) searchTerms.push(...aliases);

	const matched: NewsArticle[] = [];
	for (const item of items) {
		const text = `${item.title} ${item.snippet}`.toUpperCase();
		if (searchTerms.some((term) => text.includes(term.toUpperCase()))) {
			matched.push({
				headline: item.title,
				symbols: [symbol],
				url: item.link || null,
				source: item.source,
				publishedAt: item.pubDate,
				finnhubId: null,
			});
		}
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

	const items = await fetchUkFeeds();
	log.info(
		{ feedItems: items.length, symbols: ukSymbols.length },
		"RSS feeds fetched for UK symbols",
	);

	const result = new Map<string, NewsArticle[]>();
	for (const { symbol } of ukSymbols) {
		const articles = matchArticles(items, symbol);
		if (articles.length > 0) {
			result.set(symbol, articles);
		}
	}

	return result;
}
