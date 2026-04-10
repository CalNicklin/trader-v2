// src/news/rns-scraper.ts
//
// Polite scraper for the LSE RNS (Regulatory News Service) news listings.
// Runs from the UK news poll path when RNS_SCRAPER_ENABLED is not "false".
// Opens a circuit breaker after 3 consecutive failures to avoid banging on
// a blocking endpoint.
//
// See docs/specs/2026-04-10-lse-news-signal-fix.md Section 3.4 for rationale.

import { createChildLogger } from "../utils/logger.ts";
import type { NewsArticle } from "./finnhub.ts";

const log = createChildLogger({ module: "rns-scraper" });

const USER_AGENT = "TraderV2-Research/1.0 (+https://github.com/)";
const RATE_LIMIT_MS = 1000;
const FAILURE_THRESHOLD = 3;

type CircuitState = "closed" | "open";
let circuitState: CircuitState = "closed";
let consecutiveFailures = 0;

export function _resetRnsCircuitBreaker(): void {
	circuitState = "closed";
	consecutiveFailures = 0;
}

export function _getRnsCircuitState(): CircuitState {
	return circuitState;
}

function isEnabled(): boolean {
	return process.env.RNS_SCRAPER_ENABLED !== "false";
}

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

function rnsUrlFor(symbol: string): string {
	// LSE site uses bare ticker. Returns the stock news listing page.
	return `https://www.londonstockexchange.com/stock/${encodeURIComponent(symbol)}/news`;
}

function recordFailure(): void {
	consecutiveFailures++;
	if (consecutiveFailures >= FAILURE_THRESHOLD && circuitState === "closed") {
		circuitState = "open";
		log.warn(
			{ failures: consecutiveFailures },
			"RNS scraper circuit breaker OPEN — disabled for this poll cycle",
		);
	}
}

function recordSuccess(): void {
	consecutiveFailures = 0;
}

async function scrapeOne(symbol: string): Promise<NewsArticle[]> {
	const url = rnsUrlFor(symbol);
	try {
		const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
		if (!resp.ok) {
			log.warn({ symbol, status: resp.status }, "RNS fetch returned non-ok status");
			recordFailure();
			return [];
		}
		const html = await resp.text();
		recordSuccess();
		return parseRnsHtml(symbol, html);
	} catch (err) {
		log.warn({ symbol, err }, "RNS fetch threw");
		recordFailure();
		return [];
	}
}

function parseRnsHtml(symbol: string, html: string): NewsArticle[] {
	// Minimal parse. The LSE page lists news items in structured markup.
	// Pull headline + timestamp + link with a tolerant regex; if the HTML
	// layout changes, return [] rather than throwing.
	const articles: NewsArticle[] = [];
	const itemPattern =
		/<article[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<time[^>]*datetime="([^"]+)"/g;
	let match = itemPattern.exec(html);
	while (match !== null) {
		const link = match[1] ?? "";
		const rawTitle = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
		const pubIso = match[3] ?? "";
		if (rawTitle) {
			const publishedAt = new Date(pubIso);
			if (
				!Number.isNaN(publishedAt.getTime()) &&
				Date.now() - publishedAt.getTime() <= 24 * 60 * 60 * 1000
			) {
				articles.push({
					headline: rawTitle,
					symbols: [symbol],
					url: link.startsWith("http") ? link : `https://www.londonstockexchange.com${link}`,
					source: "RNS",
					publishedAt,
					finnhubId: null,
				});
			}
		}
		match = itemPattern.exec(html);
	}
	return articles;
}

export async function fetchRnsNews(symbols: string[]): Promise<NewsArticle[]> {
	if (!isEnabled()) {
		log.debug("RNS scraper disabled via env flag");
		return [];
	}

	const all: NewsArticle[] = [];
	for (const sym of symbols) {
		if (circuitState === "open") break;
		const batch = await scrapeOne(sym);
		all.push(...batch);
		await sleep(RATE_LIMIT_MS);
	}
	log.info(
		{ symbols: symbols.length, articles: all.length, circuit: circuitState },
		"RNS scrape complete",
	);
	return all;
}
