import { eq } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { classifyHeadline } from "../news/classifier.ts";
import type { NewsArticle } from "../news/finnhub.ts";
import { fetchCompanyNews } from "../news/finnhub.ts";
import { processArticle } from "../news/ingest.ts";
import { fetchRnsNews } from "../news/rns-scraper.ts";
import { fetchUkNewsForSymbols } from "../news/rss-feeds.ts";
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

export async function runNewsPoll(): Promise<void> {
	const config = getConfig();
	if (!config.FINNHUB_API_KEY) {
		log.warn("FINNHUB_API_KEY not set — skipping news poll");
		return;
	}

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
	for (const { symbol, exchange } of usSymbols) {
		const fhSymbol = finnhubSymbol(symbol, exchange);
		const articles = await fetchCompanyNews(fhSymbol, config.FINNHUB_API_KEY);

		for (const article of articles) {
			if (article.symbols.length === 0) {
				article.symbols = [symbol];
			}

			totalArticles++;
			const result = await processArticle(article, exchange, classifyHeadline);
			if (result === "classified") classified++;
			else if (result === "filtered") filtered++;
			else if (result === "duplicate") duplicates++;
		}

		// Respect Finnhub rate limit: 60 calls/min
		await Bun.sleep(1100);
	}

	// Non-US stocks (LSE, AIM): RSS feeds + RNS scraper
	const nonUsSymbols = watchlist.filter((s) => s.exchange !== "NASDAQ" && s.exchange !== "NYSE");
	if (nonUsSymbols.length > 0) {
		const [rssResults, rnsArticles] = await Promise.all([
			fetchUkNewsForSymbols(nonUsSymbols),
			fetchRnsNews(nonUsSymbols.map((s) => s.symbol)),
		]);

		// Index RNS articles by symbol for lookup
		const rnsBySymbol = new Map<string, NewsArticle[]>();
		for (const a of rnsArticles) {
			const sym = a.symbols[0];
			if (!sym) continue;
			const list = rnsBySymbol.get(sym) ?? [];
			list.push(a);
			rnsBySymbol.set(sym, list);
		}

		for (const { symbol, exchange } of nonUsSymbols) {
			const rss = rssResults.get(symbol) ?? [];
			const rns = rnsBySymbol.get(symbol) ?? [];
			for (const article of [...rss, ...rns]) {
				totalArticles++;
				const result = await processArticle(article, exchange, classifyHeadline);
				if (result === "classified") classified++;
				else if (result === "filtered") filtered++;
				else if (result === "duplicate") duplicates++;
			}
		}
	}

	log.info(
		{ symbols: watchlist.length, totalArticles, classified, filtered, duplicates },
		"News poll complete",
	);
}
