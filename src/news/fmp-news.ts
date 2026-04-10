// src/news/fmp-news.ts
import { fmpFetch, toFmpSymbol } from "../data/fmp.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { NewsArticle } from "./finnhub.ts";

const log = createChildLogger({ module: "fmp-news" });

interface FmpNewsRaw {
	symbol: string;
	publishedDate: string;
	publisher: string;
	title: string;
	image?: string;
	site?: string;
	text?: string;
	url: string;
}

function parseFmpArticle(raw: FmpNewsRaw): NewsArticle | null {
	if (!raw.title || !raw.url || !raw.publishedDate) return null;
	const publishedAt = new Date(`${raw.publishedDate.replace(" ", "T")}Z`);
	if (Number.isNaN(publishedAt.getTime())) return null;
	const source =
		raw.site && raw.site.length > 0
			? raw.site
			: raw.publisher && raw.publisher.length > 0
				? raw.publisher
				: "fmp";
	return {
		headline: raw.title,
		symbols: [raw.symbol],
		url: raw.url,
		source,
		publishedAt,
		finnhubId: null,
	};
}

export interface FmpNewsDeps {
	fmpFetch?: (path: string, params: Record<string, string>) => Promise<unknown>;
	toFmpSymbol?: typeof toFmpSymbol;
}

/**
 * Fetch news articles for a symbol via FMP /news/stock.
 *
 * For LSE/AIM, tries the .L variant first (e.g. "SHEL.L"). If that returns
 * no articles, falls back to the stripped variant (e.g. "SHEL") — this
 * handles dual-listed companies where FMP keys news to the US ticker.
 *
 * The production universe sometimes stores symbols with trailing dots
 * (e.g. "BP."). These are normalised to "BP" before building the FMP
 * ticker, so toFmpSymbol does not produce "BP..L".
 *
 * Attribution is always the original queried symbol, so BP. articles
 * fetched via the "BP" fallback are still attributed to "BP." downstream.
 */
export async function fetchFmpCompanyNews(
	symbol: string,
	exchange: string,
	deps: FmpNewsDeps = {},
): Promise<NewsArticle[]> {
	const fetch = deps.fmpFetch ?? fmpFetch;
	const rewrite = deps.toFmpSymbol ?? toFmpSymbol;

	const cleanSymbol = symbol.replace(/\.$/, "");
	const primary = rewrite(cleanSymbol, exchange);

	async function fetchRaw(fmpSymbol: string): Promise<FmpNewsRaw[]> {
		try {
			const data = await fetch("/news/stock", {
				symbols: fmpSymbol,
				limit: "20",
			});
			if (!Array.isArray(data)) return [];
			return data as FmpNewsRaw[];
		} catch (err) {
			log.warn({ fmpSymbol, err }, "FMP news fetch failed");
			return [];
		}
	}

	let raw = await fetchRaw(primary);

	if (raw.length === 0 && (exchange === "LSE" || exchange === "AIM") && primary !== cleanSymbol) {
		log.debug(
			{ symbol, exchange, primary, fallback: cleanSymbol },
			"No articles under .L ticker, trying US fallback",
		);
		raw = await fetchRaw(cleanSymbol);
		if (raw.length > 0) {
			log.info(
				{ symbol, exchange, fallback: cleanSymbol, count: raw.length },
				"FMP news fetched via US dual-listing fallback",
			);
		}
	}

	if (raw.length === 0) {
		log.debug({ symbol, exchange }, "FMP news returned no articles");
		return [];
	}

	const articles: NewsArticle[] = [];
	for (const rawArticle of raw) {
		const article = parseFmpArticle(rawArticle);
		if (article) {
			article.symbols = [symbol];
			articles.push(article);
		}
	}
	return articles;
}

export const _test_parseFmpArticle = parseFmpArticle;
