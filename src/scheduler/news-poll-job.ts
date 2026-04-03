import { eq } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { classifyHeadline } from "../news/classifier.ts";
import { fetchCompanyNews } from "../news/finnhub.ts";
import { isHeadlineSeen, processArticle } from "../news/ingest.ts";
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
		const universe: string[] = JSON.parse(strat.universe);
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

	for (const { symbol, exchange } of watchlist) {
		const fhSymbol = finnhubSymbol(symbol, exchange);
		const articles = await fetchCompanyNews(fhSymbol, config.FINNHUB_API_KEY);

		for (const article of articles) {
			// Ensure symbol mapping back from Finnhub format
			if (article.symbols.length === 0) {
				article.symbols = [symbol];
			}

			const seen = await isHeadlineSeen(article.headline);
			if (seen) {
				duplicates++;
				continue;
			}

			totalArticles++;
			const result = await processArticle(article, exchange, classifyHeadline);
			if (result === "classified") classified++;
			if (result === "filtered") filtered++;
		}

		// Respect Finnhub rate limit: 60 calls/min
		await Bun.sleep(1100);
	}

	log.info(
		{ symbols: watchlist.length, totalArticles, classified, filtered, duplicates },
		"News poll complete",
	);
}
