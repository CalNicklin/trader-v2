#!/usr/bin/env bun
/**
 * Free data-source dry-run.
 *
 * Probes every source we'd rely on in a "no FMP upgrade, no paid vendors" stack
 * and prints a summary. Writes nothing to the DB. Safe to run locally.
 *
 * Usage:   bun scripts/free-sources-dryrun.ts
 */

const USER_AGENT_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const USER_AGENT_EDGAR = "trader-v2-research cal@example.com"; // SEC requires a descriptive UA

interface SectionResult {
	name: string;
	ok: boolean;
	summary: string;
	sampleRows?: string[];
	error?: string;
	tookMs: number;
}

const results: SectionResult[] = [];

async function time<T>(fn: () => Promise<T>): Promise<{ value: T; tookMs: number }> {
	const start = Date.now();
	const value = await fn();
	return { value, tookMs: Date.now() - start };
}

function record(name: string, ok: boolean, summary: string, extras: Partial<SectionResult> = {}) {
	results.push({ name, ok, summary, tookMs: extras.tookMs ?? 0, ...extras });
	console.log(`${ok ? "✅" : "❌"} ${name} — ${summary}${extras.tookMs ? ` (${extras.tookMs}ms)` : ""}`);
	if (extras.sampleRows?.length) {
		for (const row of extras.sampleRows) console.log(`   ${row}`);
	}
	if (extras.error) console.log(`   ERR: ${extras.error}`);
}

// ── 1. iShares IWB (Russell 1000) ─────────────────────────────────────────────
async function probeIshareIWB() {
	const url =
		"https://www.ishares.com/us/products/239707/ishares-russell-1000-etf/1467271812596.ajax?fileType=csv&fileName=IWB_holdings&dataType=fund";
	try {
		const { value: csv, tookMs } = await time(async () => {
			const res = await fetch(url, { headers: { "User-Agent": USER_AGENT_BROWSER } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		});
		const lines = csv.split("\n");
		const headerIdx = lines.findIndex((l) => l.startsWith("Ticker,"));
		const dataLines = lines.slice(headerIdx + 1).filter((l) => l.trim().length > 0 && l.startsWith('"'));
		const tickers = dataLines
			.slice(0, 5)
			.map((l) => l.split(",")[0]?.replace(/"/g, "").trim())
			.filter(Boolean);
		record("IWB (Russell 1000)", true, `${dataLines.length} holdings`, {
			tookMs,
			sampleRows: [`top-5 tickers: ${tickers.join(", ")}`],
		});
	} catch (err) {
		record("IWB (Russell 1000)", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── 2. iShares ISF (FTSE 100) ─────────────────────────────────────────────────
async function probeIshareISF() {
	const url =
		"https://www.ishares.com/uk/individual/en/products/251795/ishares-core-ftse-100-ucits-etf/1506575576011.ajax?fileType=csv&fileName=ISF_holdings&dataType=fund";
	try {
		const { value: csv, tookMs } = await time(async () => {
			const res = await fetch(url, { headers: { "User-Agent": USER_AGENT_BROWSER } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		});
		const lines = csv.split("\n");
		const headerIdx = lines.findIndex((l) => l.startsWith("Ticker,"));
		const dataLines = lines.slice(headerIdx + 1).filter((l) => l.trim().length > 0 && l.startsWith('"'));
		const tickers = dataLines
			.slice(0, 5)
			.map((l) => l.split(",")[0]?.replace(/"/g, "").trim())
			.filter(Boolean);
		record("ISF (FTSE 100)", true, `${dataLines.length} holdings`, {
			tookMs,
			sampleRows: [`top-5 tickers: ${tickers.join(", ")}`],
		});
	} catch (err) {
		record("ISF (FTSE 100)", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── 3. Wikipedia FTSE 250 scrape ──────────────────────────────────────────────
async function probeWikipediaFTSE250() {
	const url = "https://en.wikipedia.org/wiki/FTSE_250_Index";
	try {
		const { value: html, tookMs } = await time(async () => {
			const res = await fetch(url, { headers: { "User-Agent": USER_AGENT_BROWSER } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		});
		// Find the constituents table. Wikipedia uses "wikitable sortable" and rows include EPIC codes.
		const tickers = parseWikipediaTickers(html);
		if (tickers.length < 100) {
			record("Wikipedia FTSE 250", false, `only ${tickers.length} tickers parsed (expected ~250)`, {
				tookMs,
				sampleRows: [`first-5: ${tickers.slice(0, 5).join(", ")}`],
			});
		} else {
			record("Wikipedia FTSE 250", true, `${tickers.length} tickers parsed`, {
				tookMs,
				sampleRows: [`first-5: ${tickers.slice(0, 5).join(", ")}`],
			});
		}
	} catch (err) {
		record("Wikipedia FTSE 250", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function parseWikipediaTickers(html: string): string[] {
	// Extract cells that match LSE ticker patterns. Wikipedia cells for EPIC codes look like:
	//   <td>ABDN</td>  or  <td><a ...>ABDN</a></td>
	// EPIC codes are 2–4 uppercase letters, optionally suffixed with ".A"/"."/"B" for share classes.
	const tickerPattern = /<td[^>]*>(?:<a[^>]*>)?([A-Z]{2,4}\.?[A-Z]?)(?:<\/a>)?<\/td>/g;
	const found = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = tickerPattern.exec(html)) !== null) {
		const ticker = match[1];
		if (!ticker) continue;
		// Filter out common false positives (country codes, 2-letter state codes etc.)
		if (ticker.length < 2) continue;
		found.add(ticker);
	}
	return [...found];
}

// ── 4. Wikipedia FTSE 100 (cross-check ISF) ───────────────────────────────────
async function probeWikipediaFTSE100() {
	const url = "https://en.wikipedia.org/wiki/FTSE_100_Index";
	try {
		const { value: html, tookMs } = await time(async () => {
			const res = await fetch(url, { headers: { "User-Agent": USER_AGENT_BROWSER } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		});
		const tickers = parseWikipediaTickers(html);
		record("Wikipedia FTSE 100", tickers.length >= 80, `${tickers.length} tickers parsed`, {
			tookMs,
			sampleRows: [`first-5: ${tickers.slice(0, 5).join(", ")}`],
		});
	} catch (err) {
		record("Wikipedia FTSE 100", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── 5. Yahoo Finance chart endpoint (UK symbol) ───────────────────────────────
async function probeYahooChartUK() {
	const url =
		"https://query1.finance.yahoo.com/v8/finance/chart/BP.L?interval=1d&range=5d";
	try {
		const { value: data, tookMs } = await time(async () => {
			const res = await fetch(url, { headers: { "User-Agent": USER_AGENT_BROWSER } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json() as Promise<{
				chart: {
					result: Array<{
						meta: {
							symbol: string;
							currency: string;
							exchangeName: string;
							regularMarketPrice: number;
							regularMarketVolume?: number;
						};
					}>;
				};
			}>;
		});
		const meta = data.chart?.result?.[0]?.meta;
		if (!meta) throw new Error("no meta in response");
		record("Yahoo chart (BP.L)", true, `${meta.symbol} ${meta.regularMarketPrice}${meta.currency}`, {
			tookMs,
			sampleRows: [`exchange=${meta.exchangeName}, vol=${meta.regularMarketVolume ?? "?"}`],
		});
	} catch (err) {
		record("Yahoo chart (BP.L)", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── 6. Yahoo Finance chart for an AIM name ────────────────────────────────────
async function probeYahooChartAIM() {
	const url =
		"https://query1.finance.yahoo.com/v8/finance/chart/GAW.L?interval=1d&range=5d";
	try {
		const { value: data, tookMs } = await time(async () => {
			const res = await fetch(url, { headers: { "User-Agent": USER_AGENT_BROWSER } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json() as Promise<{
				chart: { result: Array<{ meta: { symbol: string; regularMarketPrice: number; currency: string } }> };
			}>;
		});
		const meta = data.chart?.result?.[0]?.meta;
		if (!meta) throw new Error("no meta in response");
		record("Yahoo chart (GAW.L, AIM)", true, `${meta.symbol} ${meta.regularMarketPrice}${meta.currency}`, {
			tookMs,
		});
	} catch (err) {
		record("Yahoo chart (GAW.L, AIM)", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── 7. Yahoo Finance RSS news ──────────────────────────────────────────────────
async function probeYahooRSS() {
	const url = "https://finance.yahoo.com/rss/headline?s=BP.L";
	try {
		const { value: xml, tookMs } = await time(async () => {
			const res = await fetch(url, { headers: { "User-Agent": USER_AGENT_BROWSER } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		});
		const titles = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1]).filter(Boolean);
		const itemTitles = titles.slice(1); // first title is channel title
		record("Yahoo RSS (BP.L news)", itemTitles.length > 0, `${itemTitles.length} items`, {
			tookMs,
			sampleRows: itemTitles.slice(0, 2).map((t) => `"${t?.slice(0, 80)}"`),
		});
	} catch (err) {
		record("Yahoo RSS (BP.L news)", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── 8. SEC EDGAR submissions (insider flag + basic metadata) ──────────────────
async function probeEdgar() {
	// CIK 0000320193 = Apple Inc.
	const url = "https://data.sec.gov/submissions/CIK0000320193.json";
	try {
		const { value: data, tookMs } = await time(async () => {
			const res = await fetch(url, { headers: { "User-Agent": USER_AGENT_EDGAR } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json() as Promise<{
				name: string;
				tickers: string[];
				exchanges: string[];
				insiderTransactionForIssuerExists: number;
				filings: { recent: { form: string[]; filingDate: string[] } };
			}>;
		});
		const recentForms = data.filings?.recent?.form ?? [];
		const form4Count = recentForms.filter((f) => f === "4").length;
		record("SEC EDGAR (AAPL submissions)", true, `insider=${data.insiderTransactionForIssuerExists}`, {
			tookMs,
			sampleRows: [`recent Form 4 filings in buffer: ${form4Count}`, `tickers: ${data.tickers.join(",")} on ${data.exchanges.join(",")}`],
		});
	} catch (err) {
		record("SEC EDGAR (AAPL submissions)", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── 9. Frankfurter FX ─────────────────────────────────────────────────────────
async function probeFrankfurter() {
	const url = "https://api.frankfurter.dev/v1/latest?from=GBP&to=USD";
	try {
		const { value: data, tookMs } = await time(async () => {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json() as Promise<{ amount: number; base: string; date: string; rates: Record<string, number> }>;
		});
		record("Frankfurter FX (GBP→USD)", true, `${data.base}→USD ${data.rates.USD} on ${data.date}`, {
			tookMs,
		});
	} catch (err) {
		record("Frankfurter FX (GBP→USD)", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── 10. Yahoo v10 quoteSummary (fundamentals) — known-brittle ─────────────────
async function probeYahooQuoteSummary() {
	// This one requires crumb+cookie dance. Test whether it's reachable at all.
	const url =
		"https://query1.finance.yahoo.com/v10/finance/quoteSummary/BP.L?modules=summaryDetail,defaultKeyStatistics,price";
	try {
		const { value, tookMs } = await time(async () => {
			const res = await fetch(url, { headers: { "User-Agent": USER_AGENT_BROWSER } });
			return { status: res.status, body: await res.text() };
		});
		const ok = value.status === 200;
		record(
			"Yahoo v10 quoteSummary (fundamentals)",
			ok,
			ok ? "direct fetch worked" : `HTTP ${value.status} — brittle, needs yahoo-finance2 lib`,
			{
				tookMs,
				sampleRows: ok ? [] : [`body snippet: ${value.body.slice(0, 120)}`],
			},
		);
	} catch (err) {
		record("Yahoo v10 quoteSummary (fundamentals)", false, "fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
	console.log("Free data-source dry-run — probing each endpoint\n");

	// Run in parallel; each probe is independent
	await Promise.all([
		probeIshareIWB(),
		probeIshareISF(),
		probeWikipediaFTSE100(),
		probeWikipediaFTSE250(),
		probeYahooChartUK(),
		probeYahooChartAIM(),
		probeYahooRSS(),
		probeEdgar(),
		probeFrankfurter(),
		probeYahooQuoteSummary(),
	]);

	const ok = results.filter((r) => r.ok).length;
	const fail = results.length - ok;
	console.log(`\n─────────────────────────────────\nSummary: ${ok}/${results.length} sources working, ${fail} failing`);
	if (fail > 0) {
		console.log("\nFailing sources:");
		for (const r of results.filter((x) => !x.ok)) {
			console.log(`  - ${r.name}: ${r.summary}`);
		}
	}
}

await main();
