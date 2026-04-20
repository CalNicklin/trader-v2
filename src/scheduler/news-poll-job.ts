import { eq } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { classifyHeadline } from "../news/classifier.ts";
import { fetchCompanyNews, type NewsArticle } from "../news/finnhub.ts";
import { processArticle } from "../news/ingest.ts";
import { fetchYahooRssUk, type YahooRssItem } from "../news/yahoo-rss-uk.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "news-poll-job" });

/**
 * Collect all unique symbols from paper strategy universes.
 */
async function getWatchlistSymbols(): Promise<Array<{ symbol: string; exchange: string }>> {
	const db = getDb();
	const paperStrategies = await db
		.select({ universe: strategies.universe })
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	const seen = new Set<string>();
	const result: Array<{ symbol: string; exchange: string }> = [];

	for (const strat of paperStrategies) {
		if (!strat.universe) continue;
		let universe: string[];
		try {
			universe = JSON.parse(strat.universe);
		} catch {
			log.warn({ universe: strat.universe }, "Malformed universe JSON — skipping");
			continue;
		}
		for (const spec of universe) {
			const [symbol, exchange] = spec.includes(":") ? spec.split(":") : [spec, "NASDAQ"];
			const key = `${symbol}:${exchange}`;
			if (!seen.has(key)) {
				seen.add(key);
				result.push({ symbol: symbol!, exchange: exchange! });
			}
		}
	}

	return result;
}

/**
 * Map exchange to Finnhub symbol format.
 * Finnhub uses plain symbols for US, and SYMBOL.L for LSE/AIM.
 */
function finnhubSymbol(symbol: string, exchange: string): string {
	if (exchange === "LSE" || exchange === "AIM") return `${symbol}.L`;
	return symbol;
}

export interface NewsPollDeps {
	fetchCompanyNews?: typeof fetchCompanyNews;
	fetchYahooRssUk?: typeof fetchYahooRssUk;
	processArticle?: typeof processArticle;
}

function yahooItemToArticle(item: YahooRssItem, symbol: string): NewsArticle {
	const published = Number.isNaN(Date.parse(item.pubDate)) ? new Date() : new Date(item.pubDate);
	return {
		headline: item.title,
		symbols: [symbol],
		url: item.link,
		source: "yahoo_rss",
		publishedAt: published,
		finnhubId: null,
	};
}

export async function runNewsPoll(deps: NewsPollDeps = {}): Promise<void> {
	const config = getConfig();
	const fetchUs = deps.fetchCompanyNews ?? fetchCompanyNews;
	const fetchUk = deps.fetchYahooRssUk ?? fetchYahooRssUk;
	const ingest = deps.processArticle ?? processArticle;

	const watchlist = await getWatchlistSymbols();
	if (watchlist.length === 0) {
		log.debug("No symbols in watchlist — skipping news poll");
		return;
	}

	let totalArticles = 0;
	let classified = 0;
	let filtered = 0;
	let duplicates = 0;

	// US stocks: Finnhub API
	const usSymbols = watchlist.filter((s) => s.exchange === "NASDAQ" || s.exchange === "NYSE");
	const finnhubKey = config.FINNHUB_API_KEY;
	if (usSymbols.length > 0 && !finnhubKey) {
		log.warn("FINNHUB_API_KEY not set — skipping US news poll");
	} else {
		for (const { symbol, exchange } of usSymbols) {
			const fhSymbol = finnhubSymbol(symbol, exchange);
			const articles = await fetchUs(fhSymbol, finnhubKey ?? "");

			for (const article of articles) {
				if (article.symbols.length === 0) {
					article.symbols = [symbol];
				}

				totalArticles++;
				const result = await ingest(article, exchange, classifyHeadline);
				if (result === "classified") classified++;
				else if (result === "filtered") filtered++;
				else if (result === "duplicate") duplicates++;
			}

			// Respect Finnhub rate limit: 60 calls/min
			await Bun.sleep(1100);
		}
	}

	// Non-US stocks (LSE, AIM): Yahoo RSS per-symbol. FMP UK news returns []
	// on our tier, so we use Yahoo RSS as the authoritative UK feed.
	const nonUsSymbols = watchlist.filter((s) => s.exchange === "LSE" || s.exchange === "AIM");
	if (nonUsSymbols.length > 0) {
		let lseArticles = 0;
		log.info({ symbolCount: nonUsSymbols.length }, "Polling Yahoo RSS per symbol for LSE/AIM");
		for (const { symbol, exchange } of nonUsSymbols) {
			const items = await fetchUk(symbol, exchange);
			for (const item of items) {
				const article = yahooItemToArticle(item, symbol);
				totalArticles++;
				lseArticles++;
				const result = await ingest(article, exchange, classifyHeadline);
				if (result === "classified") classified++;
				else if (result === "filtered") filtered++;
				else if (result === "duplicate") duplicates++;
			}
			// Polite pacing — Yahoo isn't as strict as FMP but 200ms is fine.
			await Bun.sleep(200);
		}
		log.info(
			{ exchange: "LSE", symbols: nonUsSymbols.length, articles: lseArticles },
			"Yahoo RSS news poll complete",
		);
	}

	log.info(
		{ symbols: watchlist.length, totalArticles, classified, filtered, duplicates },
		"News poll complete",
	);
}
