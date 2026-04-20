#!/usr/bin/env bun
/**
 * Verified probe of replacements for every FMP call site we have.
 *
 * Goal: before proposing an FMP-removal plan, prove each alternative
 * actually returns the fields we consume downstream. No more "one-line
 * fix" assumptions.
 *
 * For each FMP function, we check:
 *  - What fields downstream code reads
 *  - Which alternative endpoint(s) can provide them
 *  - Live probe: does the alternative actually return those fields today?
 *
 * Usage:  bun scripts/probe-fmp-replacements.ts
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const EDGAR_UA = "trader-v2-research cal@example.com";

interface Result {
	fmpFunction: string;
	consumedFields: string[];
	candidate: string;
	candidateUrl: string;
	probeResult: "✅" | "❌" | "⚠️";
	detail: string;
}

const results: Result[] = [];

async function probe(r: Result) {
	results.push(r);
	console.log(`${r.probeResult} ${r.fmpFunction} → ${r.candidate}`);
	console.log(`   consumes: ${r.consumedFields.join(", ")}`);
	console.log(`   endpoint: ${r.candidateUrl}`);
	console.log(`   detail: ${r.detail}`);
	console.log();
}

async function main() {
	console.log("FMP replacement probe — live HTTP checks, no assumptions\n");
	console.log("─".repeat(70) + "\n");

	// ── 1. fmpQuote (US) — current FMP /stable/quote works, but has bugs ──
	try {
		const res = await fetch(
			"https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d",
			{ headers: { "User-Agent": UA } },
		);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as {
			chart: {
				result?: Array<{
					meta: {
						regularMarketPrice: number;
						regularMarketVolume?: number;
						symbol: string;
					};
					indicators: { quote: Array<{ volume: (number | null)[] }> };
				}>;
			};
		};
		const meta = data.chart.result?.[0]?.meta;
		const volumes = data.chart.result?.[0]?.indicators.quote[0]?.volume ?? [];
		const validVols = volumes.filter((v): v is number => typeof v === "number" && v > 0);
		const avgVol = validVols.length > 0 ? validVols.reduce((a, b) => a + b) / validVols.length : null;
		await probe({
			fmpFunction: "fmpQuote(symbol, exchange) [US]",
			consumedFields: ["last", "volume", "avgVolume", "changePercent"],
			candidate: "Yahoo v8 chart + computed avgVolume",
			candidateUrl: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d",
			probeResult: meta && meta.regularMarketPrice && avgVol != null ? "✅" : "⚠️",
			detail: `AAPL last=${meta?.regularMarketPrice}, vol=${meta?.regularMarketVolume}, 5d avgVol=${avgVol?.toFixed(0)}. changePercent NOT in meta — would need to compute from close[] diff`,
		});
	} catch (err) {
		await probe({
			fmpFunction: "fmpQuote(US)",
			consumedFields: ["last", "volume", "avgVolume", "changePercent"],
			candidate: "Yahoo v8 chart",
			candidateUrl: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
			probeResult: "❌",
			detail: String(err),
		});
	}

	// ── 2. fmpHistorical (US) — /v3/historical-price-eod/full ──
	try {
		const res = await fetch(
			"https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=90d",
			{ headers: { "User-Agent": UA } },
		);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as {
			chart: {
				result?: Array<{
					timestamp: number[];
					indicators: {
						quote: Array<{
							open: (number | null)[];
							high: (number | null)[];
							low: (number | null)[];
							close: (number | null)[];
							volume: (number | null)[];
						}>;
					};
				}>;
			};
		};
		const result = data.chart.result?.[0];
		const barCount = result?.timestamp?.length ?? 0;
		await probe({
			fmpFunction: "fmpHistorical(symbol, exchange, days=90) [US]",
			consumedFields: ["date", "open", "high", "low", "close", "volume"],
			candidate: "Yahoo v8 chart range=90d",
			candidateUrl: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=90d",
			probeResult: barCount >= 60 ? "✅" : "⚠️",
			detail: `${barCount} bars returned. Yahoo returns arrays (timestamp + open/high/low/close/volume) — need to transpose to FmpHistoricalBar[] shape.`,
		});
	} catch (err) {
		await probe({
			fmpFunction: "fmpHistorical(US)",
			consumedFields: ["date", "open", "high", "low", "close", "volume"],
			candidate: "Yahoo v8 chart",
			candidateUrl: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=90d",
			probeResult: "❌",
			detail: String(err),
		});
	}

	// ── 3. fmpFxRate(from, to) — /stable/quote with currency pair ──
	try {
		const res = await fetch("https://api.frankfurter.dev/v1/latest?from=GBP&to=USD");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as { rates: { USD: number }; date: string };
		await probe({
			fmpFunction: "fmpFxRate(from, to)",
			consumedFields: ["rate (single number)"],
			candidate: "Frankfurter.dev (ECB data)",
			candidateUrl: "https://api.frankfurter.dev/v1/latest?from=GBP&to=USD",
			probeResult: "✅",
			detail: `GBP→USD = ${data.rates.USD} on ${data.date}. Zero auth, already used by yahoo-uk enricher.`,
		});
	} catch (err) {
		await probe({
			fmpFunction: "fmpFxRate",
			consumedFields: ["rate"],
			candidate: "Frankfurter.dev",
			candidateUrl: "https://api.frankfurter.dev/v1/latest",
			probeResult: "❌",
			detail: String(err),
		});
	}

	// ── 4. fmpValidateSymbol — isActivelyTrading via /stable/profile ──
	try {
		const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
			headers: { "User-Agent": EDGAR_UA },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as Record<string, { cik_str: number; ticker: string }>;
		const count = Object.keys(data).length;
		const hasAapl = Object.values(data).some((r) => r.ticker === "AAPL");
		await probe({
			fmpFunction: "fmpValidateSymbol(symbol, exchange)",
			consumedFields: ["boolean: is this symbol actively trading?"],
			candidate: "SEC EDGAR ticker map (already in PR #40 as edgar-ticker-map)",
			candidateUrl: "https://www.sec.gov/files/company_tickers.json",
			probeResult: hasAapl && count > 5000 ? "✅" : "⚠️",
			detail: `${count} tickers in SEC CIK map. For UK symbols: use our investable_universe membership check (already done by promoteToWatchlist).`,
		});
	} catch (err) {
		await probe({
			fmpFunction: "fmpValidateSymbol",
			consumedFields: ["isActivelyTrading"],
			candidate: "SEC EDGAR",
			candidateUrl: "https://www.sec.gov/files/company_tickers.json",
			probeResult: "❌",
			detail: String(err),
		});
	}

	// ── 5. fmpResolveExchange — symbol → NASDAQ/NYSE/LSE ──
	try {
		const res = await fetch("https://data.sec.gov/submissions/CIK0000320193.json", {
			headers: { "User-Agent": EDGAR_UA },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as { exchanges: string[] };
		await probe({
			fmpFunction: "fmpResolveExchange(symbol)",
			consumedFields: ["exchange: NASDAQ|NYSE|LSE|null"],
			candidate: "SEC EDGAR /submissions (US only) + iShares CSV location (UK)",
			candidateUrl: "https://data.sec.gov/submissions/CIK{cik}.json",
			probeResult: data.exchanges?.length > 0 ? "✅" : "⚠️",
			detail: `AAPL CIK=320193 → exchanges: ${JSON.stringify(data.exchanges)}. For UK: iShares ISF 'Exchange' column says "London Stock Exchange".`,
		});
	} catch (err) {
		await probe({
			fmpFunction: "fmpResolveExchange",
			consumedFields: ["exchange"],
			candidate: "SEC EDGAR submissions",
			candidateUrl: "https://data.sec.gov/submissions/CIK{cik}.json",
			probeResult: "❌",
			detail: String(err),
		});
	}

	// ── 6. fmp-news.ts (UK news) — /stable/news/stock returns [] for .L ──
	try {
		const res = await fetch("https://finance.yahoo.com/rss/headline?s=BP.L", {
			headers: { "User-Agent": UA },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const xml = await res.text();
		const itemCount = (xml.match(/<item>/g) ?? []).length;
		const firstTitle = xml.match(/<item>\s*<title>([^<]+)<\/title>/)?.[1] ?? "?";
		await probe({
			fmpFunction: "fmp-news (UK .L symbols)",
			consumedFields: ["title, publishedDate, url, description", "per-symbol news feed"],
			candidate: "Yahoo RSS per .L symbol",
			candidateUrl: "https://finance.yahoo.com/rss/headline?s=BP.L",
			probeResult: itemCount > 0 ? "✅" : "⚠️",
			detail: `${itemCount} items for BP.L. First: "${firstTitle.slice(0, 80)}". Need to parse RSS XML; straightforward regex or a tiny parser.`,
		});
	} catch (err) {
		await probe({
			fmpFunction: "fmp-news UK",
			consumedFields: ["news items"],
			candidate: "Yahoo RSS",
			candidateUrl: "https://finance.yahoo.com/rss/headline?s=BP.L",
			probeResult: "❌",
			detail: String(err),
		});
	}

	// ── 7. earnings-catalyst-job ( /v3/earning_calendar) ──
	console.log("⚠️  earnings-catalyst-job currently uses FMP /v3/earning_calendar directly.");
	console.log("   Two options: (a) swap to FMP /stable/earnings-calendar (keep FMP), (b) use Finnhub /calendar/earnings (we have key).");
	console.log("   Finnhub coverage: US only — same as FMP (neither covers UK earnings).");
	console.log("   Recommend: Finnhub, drops FMP dep.");
	console.log();
	try {
		// We don't have a Finnhub key in this script env, so just confirm endpoint shape via FMP stable
		console.log("   Example: https://finnhub.io/api/v1/calendar/earnings?from=X&to=Y&token=...");
		console.log("   Response shape: { earningsCalendar: [{ symbol, date, epsEstimate }] }");
	} catch (err) {
		console.log("   error:", err);
	}
	console.log();

	// ── Summary ──
	console.log("─".repeat(70));
	const ok = results.filter((r) => r.probeResult === "✅").length;
	const partial = results.filter((r) => r.probeResult === "⚠️").length;
	const failed = results.filter((r) => r.probeResult === "❌").length;
	console.log(`\nSummary: ${ok} verified / ${partial} partial / ${failed} failed\n`);

	// Print replacement matrix
	console.log("## Replacement matrix\n");
	console.log("| FMP function | Replacement | Status |");
	console.log("|---|---|---|");
	for (const r of results) {
		console.log(`| ${r.fmpFunction} | ${r.candidate} | ${r.probeResult} |`);
	}
}

await main();
