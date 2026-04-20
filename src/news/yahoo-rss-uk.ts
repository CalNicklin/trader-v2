import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "yahoo-rss-uk" });

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export interface YahooRssItem {
	title: string;
	pubDate: string;
	link: string;
	description: string;
	source: "yahoo_rss";
}

export interface YahooRssFetchDeps {
	fetchImpl?: typeof fetch;
}

// Yahoo Finance publishes a per-symbol RSS feed. For UK, we append `.L` to the
// bare ticker (works for both LSE-main and AIM — Yahoo treats them the same).
export async function fetchYahooRssUk(
	symbol: string,
	_exchange: string,
	deps: YahooRssFetchDeps = {},
): Promise<YahooRssItem[]> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const yahooSymbol = `${symbol}.L`;
	const url = `https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(yahooSymbol)}`;
	try {
		const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
		if (!res.ok) {
			log.debug({ symbol, status: res.status }, "Yahoo RSS non-200");
			return [];
		}
		const xml = await res.text();
		const items = parseYahooRssXml(xml);
		log.info({ symbol, count: items.length }, "Yahoo RSS fetched");
		return items;
	} catch (err) {
		log.debug(
			{ symbol, err: err instanceof Error ? err.message : String(err) },
			"Yahoo RSS fetch failed",
		);
		return [];
	}
}

// Minimal RSS parser — Yahoo's feed is well-formed and small, so a regex-based
// extractor is sufficient and avoids pulling in an XML dependency.
export function parseYahooRssXml(xml: string): YahooRssItem[] {
	const items: YahooRssItem[] = [];
	const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
	for (const match of itemMatches) {
		const body = match[1];
		if (!body) continue;
		const title = extractField(body, "title");
		const link = extractField(body, "link");
		const pubDate = extractField(body, "pubDate");
		const description = extractField(body, "description");
		if (!title || !link) continue;
		items.push({
			title,
			pubDate: pubDate ?? "",
			link,
			description: description ?? "",
			source: "yahoo_rss",
		});
	}
	return items;
}

function extractField(body: string, tag: string): string | null {
	const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`);
	const m = body.match(re);
	return m?.[1]?.trim() ?? null;
}
