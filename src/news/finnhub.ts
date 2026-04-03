import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";

const log = createChildLogger({ module: "finnhub" });

export interface NewsArticle {
	headline: string;
	symbols: string[];
	url: string | null;
	source: string;
	publishedAt: Date;
	finnhubId: number | null;
}

export function buildFinnhubUrl(symbol: string, apiKey: string): string {
	const now = new Date();
	const from = new Date(now.getTime() - 24 * 60 * 60 * 1000); // last 24h
	const fromStr = from.toISOString().split("T")[0];
	const toStr = now.toISOString().split("T")[0];
	return `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fromStr}&to=${toStr}&token=${apiKey}`;
}

export function parseFinnhubArticle(raw: Record<string, unknown>): NewsArticle | null {
	const headline = raw.headline;
	if (typeof headline !== "string" || headline.length === 0) return null;

	const related = typeof raw.related === "string" ? raw.related : "";
	const symbols = related
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const datetime = typeof raw.datetime === "number" ? raw.datetime : 0;

	return {
		headline,
		symbols,
		url: typeof raw.url === "string" ? raw.url : null,
		source: "finnhub",
		publishedAt: new Date(datetime * 1000),
		finnhubId: typeof raw.id === "number" ? raw.id : null,
	};
}

/**
 * Fetch recent news articles for a symbol from Finnhub.
 * Returns parsed articles, deduped by headline.
 */
export async function fetchCompanyNews(symbol: string, apiKey: string): Promise<NewsArticle[]> {
	const url = buildFinnhubUrl(symbol, apiKey);

	const response = await withRetry(
		async () => {
			const res = await fetch(url);
			if (res.status === 429) throw new Error("Finnhub rate limited");
			if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
			return res;
		},
		`finnhub-news-${symbol}`,
		{ maxAttempts: 2, baseDelayMs: 2000 },
	);

	const data: unknown[] = await response.json();

	if (!Array.isArray(data)) {
		log.warn({ symbol }, "Finnhub returned non-array response");
		return [];
	}

	const articles: NewsArticle[] = [];
	for (const item of data) {
		if (typeof item !== "object" || item === null) continue;
		const article = parseFinnhubArticle(item as Record<string, unknown>);
		if (article) articles.push(article);
	}

	return articles;
}
