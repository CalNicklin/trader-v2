#!/usr/bin/env bun
/**
 * Probe every known candidate for replacing FMP `/v3/profile/` (US market cap,
 * shares outstanding, free float, IPO date).
 *
 * Goal: identify a source that gives us enough of those fields for the
 * ~1000 Russell 1000 symbols to pass the liquidity filter.
 *
 * Each probe reports:
 *   - HTTP status / reachability
 *   - Which fields we can extract
 *   - Sample values for AAPL, NVDA, TSLA
 *
 * Usage:  bun scripts/probe-us-profile-alternatives.ts
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const EDGAR_UA = "trader-v2 cal@example.com";

interface ProbeResult {
	name: string;
	endpoint: string;
	ok: boolean;
	fields: Record<string, unknown>;
	notes?: string;
	tookMs: number;
}

const results: ProbeResult[] = [];

function record(r: ProbeResult) {
	results.push(r);
	console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
	console.log(`   endpoint: ${r.endpoint}`);
	if (r.ok) {
		for (const [k, v] of Object.entries(r.fields)) {
			if (v != null) console.log(`   ${k}: ${String(v).slice(0, 80)}`);
		}
	}
	if (r.notes) console.log(`   notes: ${r.notes}`);
	console.log(`   took: ${r.tookMs}ms\n`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; tookMs: number }> {
	const t0 = Date.now();
	return { value: await fn(), tookMs: Date.now() - t0 };
}

// ── Option 1: FMP /v3/profile (baseline, expected 403) ────────────────────────
async function probeFmp() {
	const endpoint = `https://financialmodelingprep.com/api/v3/profile/AAPL?apikey=${process.env.FMP_API_KEY ?? "no-key"}`;
	try {
		const { value, tookMs } = await timed(async () => {
			const res = await fetch(endpoint);
			return { status: res.status, body: await res.text() };
		});
		record({
			name: "FMP /v3/profile (legacy)",
			endpoint: endpoint.replace(/apikey=[^&]+/, "apikey=***"),
			ok: value.status === 200,
			fields: {},
			notes: value.status !== 200 ? `HTTP ${value.status}: ${value.body.slice(0, 120)}` : "",
			tookMs,
		});
	} catch (err) {
		record({
			name: "FMP /v3/profile",
			endpoint,
			ok: false,
			fields: {},
			notes: err instanceof Error ? err.message : String(err),
			tookMs: 0,
		});
	}
}

// ── Option 2: Yahoo v8 chart — has marketCap in meta? ─────────────────────────
async function probeYahooChart() {
	const endpoint = "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1mo";
	try {
		const { value, tookMs } = await timed(async () => {
			const res = await fetch(endpoint, { headers: { "User-Agent": UA } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json() as Promise<{
				chart: {
					result?: Array<{
						meta: {
							symbol: string;
							currency: string;
							regularMarketPrice: number;
							firstTradeDate?: number;
							[key: string]: unknown;
						};
					}>;
				};
			}>;
		});
		const meta = value.chart.result?.[0]?.meta ?? {};
		record({
			name: "Yahoo v8 chart (meta fields)",
			endpoint,
			ok: true,
			fields: {
				symbol: meta.symbol,
				price: meta.regularMarketPrice,
				firstTradeDate: meta.firstTradeDate
					? new Date((meta.firstTradeDate as number) * 1000).toISOString().slice(0, 10)
					: "missing",
				allMetaKeys: Object.keys(meta).join(", "),
			},
			notes: "Chart endpoint meta lacks marketCap / sharesOutstanding — need a different endpoint",
			tookMs,
		});
	} catch (err) {
		record({
			name: "Yahoo v8 chart",
			endpoint,
			ok: false,
			fields: {},
			notes: err instanceof Error ? err.message : String(err),
			tookMs: 0,
		});
	}
}

// ── Option 3: Yahoo v7 quote (has marketCap) — crumb needed? ──────────────────
async function probeYahooV7Quote() {
	const endpoint =
		"https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL&fields=marketCap,sharesOutstanding,regularMarketPrice,firstTradeDateEpochUtc";
	try {
		const { value, tookMs } = await timed(async () => {
			const res = await fetch(endpoint, { headers: { "User-Agent": UA } });
			return { status: res.status, body: await res.text() };
		});
		record({
			name: "Yahoo v7 quote (marketCap + sharesOutstanding)",
			endpoint,
			ok: value.status === 200,
			fields: {},
			notes:
				value.status === 200
					? `Response: ${value.body.slice(0, 200)}`
					: `HTTP ${value.status} — ${value.body.slice(0, 100)}`,
			tookMs,
		});
	} catch (err) {
		record({
			name: "Yahoo v7 quote",
			endpoint,
			ok: false,
			fields: {},
			notes: err instanceof Error ? err.message : String(err),
			tookMs: 0,
		});
	}
}

// ── Option 4: SEC EDGAR company facts (XBRL — market cap via SharesOutstanding × price) ───
async function probeSecEdgarFacts() {
	// CIK 0000320193 = Apple Inc.
	const endpoint = "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json";
	try {
		const { value, tookMs } = await timed(async () => {
			const res = await fetch(endpoint, { headers: { "User-Agent": EDGAR_UA } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json() as Promise<{
				entityName: string;
				facts: {
					"us-gaap"?: {
						CommonStockSharesOutstanding?: {
							units: { shares?: Array<{ end: string; val: number }> };
						};
					};
					dei?: {
						EntityCommonStockSharesOutstanding?: {
							units: { shares?: Array<{ end: string; val: number }> };
						};
					};
				};
			}>;
		});
		const shares =
			value.facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ??
			value.facts["us-gaap"]?.CommonStockSharesOutstanding?.units?.shares ??
			[];
		const latest = shares.sort((a, b) => b.end.localeCompare(a.end))[0];
		record({
			name: "SEC EDGAR /api/xbrl/companyfacts",
			endpoint,
			ok: true,
			fields: {
				entityName: value.entityName,
				latestSharesOutstanding: latest?.val,
				asOf: latest?.end,
			},
			notes:
				"For market cap, multiply sharesOutstanding × current price (Yahoo chart). " +
				"Need CIK lookup table to map ticker→CIK (SEC provides free: tickers.txt).",
			tookMs,
		});
	} catch (err) {
		record({
			name: "SEC EDGAR companyfacts",
			endpoint,
			ok: false,
			fields: {},
			notes: err instanceof Error ? err.message : String(err),
			tookMs: 0,
		});
	}
}

// ── Option 5: SEC EDGAR submissions (IPO date / listing info) ─────────────────
async function probeSecEdgarSubmissions() {
	const endpoint = "https://data.sec.gov/submissions/CIK0000320193.json";
	try {
		const { value, tookMs } = await timed(async () => {
			const res = await fetch(endpoint, { headers: { "User-Agent": EDGAR_UA } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json() as Promise<{
				name: string;
				tickers: string[];
				exchanges: string[];
				formerNames: Array<{ name: string; from: string; to: string }>;
				filings: { recent: { filingDate: string[]; form: string[] } };
			}>;
		});
		// Earliest filing approximates listing date; for IPO date we'd need the S-1
		const dates = value.filings.recent.filingDate;
		const earliest = dates?.[dates.length - 1] ?? "?";
		record({
			name: "SEC EDGAR /submissions (IPO proxy via earliest filing)",
			endpoint,
			ok: true,
			fields: {
				entity: value.name,
				tickers: value.tickers.join(","),
				exchanges: value.exchanges.join(","),
				earliestRecentFiling: earliest,
				formerNames: value.formerNames.length,
			},
			notes: "Filings buffer is only ~1000 rows; for true IPO date fetch /filings/*.json with start=1",
			tookMs,
		});
	} catch (err) {
		record({
			name: "SEC EDGAR submissions",
			endpoint,
			ok: false,
			fields: {},
			notes: err instanceof Error ? err.message : String(err),
			tookMs: 0,
		});
	}
}

// ── Option 6: SEC EDGAR tickers.txt (CIK mapping — needed to use EDGAR) ───────
async function probeSecEdgarTickers() {
	const endpoint = "https://www.sec.gov/files/company_tickers.json";
	try {
		const { value, tookMs } = await timed(async () => {
			const res = await fetch(endpoint, { headers: { "User-Agent": EDGAR_UA } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json() as Promise<Record<string, { cik_str: number; ticker: string; title: string }>>;
		});
		const aapl = Object.values(value).find((v) => v.ticker === "AAPL");
		record({
			name: "SEC EDGAR /files/company_tickers.json (CIK map)",
			endpoint,
			ok: true,
			fields: {
				totalTickers: Object.keys(value).length,
				aaplCIK: aapl?.cik_str,
			},
			notes: "Use this to resolve ticker → CIK for companyfacts / submissions lookups",
			tookMs,
		});
	} catch (err) {
		record({
			name: "SEC EDGAR tickers",
			endpoint,
			ok: false,
			fields: {},
			notes: err instanceof Error ? err.message : String(err),
			tookMs: 0,
		});
	}
}

// ── Option 7: iShares IWB CSV Market Value column ─────────────────────────────
async function probeIwbMarketValue() {
	const endpoint =
		"https://www.ishares.com/us/products/239707/ishares-russell-1000-etf/1467271812596.ajax?fileType=csv&fileName=IWB_holdings&dataType=fund";
	try {
		const { value, tookMs } = await timed(async () => {
			const res = await fetch(endpoint, { headers: { "User-Agent": UA } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		});
		const lines = value.split("\n");
		const headerIdx = lines.findIndex((l) => l.startsWith("Ticker,"));
		const sample = lines.slice(headerIdx + 1, headerIdx + 4).filter((l) => l.trim().startsWith('"'));
		// Columns: Ticker, Name, Sector, AssetClass, MarketValue, Weight, Notional, Quantity, Price, Location, Exchange, Currency, FXRate, MarketCurrency, AccrualDate
		const parsed = sample.map((l) => {
			const cells = l.replace(/^"|"$/g, "").split('","');
			return {
				ticker: cells[0],
				marketValueInFund: cells[4],
				weight: cells[5],
				quantity: cells[7],
				price: cells[8],
			};
		});
		record({
			name: "iShares IWB holdings CSV (Market Value + Price)",
			endpoint,
			ok: true,
			fields: {
				totalHoldings: lines.slice(headerIdx + 1).filter((l) => l.trim().startsWith('"')).length,
				sample: JSON.stringify(parsed.slice(0, 2)),
			},
			notes:
				"MarketValue is ETF's holding value, NOT company market cap. Price × total sharesOutstanding " +
				"would give market cap but sharesOutstanding isn't in the CSV. Useful for relative weighting only.",
			tookMs,
		});
	} catch (err) {
		record({
			name: "iShares IWB CSV",
			endpoint,
			ok: false,
			fields: {},
			notes: err instanceof Error ? err.message : String(err),
			tookMs: 0,
		});
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
	console.log("Probing FMP-replacement candidates for US profile data\n");
	console.log("─".repeat(70) + "\n");

	// Run sequentially so output is readable
	await probeFmp();
	await probeYahooChart();
	await probeYahooV7Quote();
	await probeSecEdgarFacts();
	await probeSecEdgarSubmissions();
	await probeSecEdgarTickers();
	await probeIwbMarketValue();

	const working = results.filter((r) => r.ok).length;
	console.log("─".repeat(70));
	console.log(`Summary: ${working}/${results.length} endpoints reachable\n`);

	console.log("Viable replacements for FMP /v3/profile:");
	const viable: string[] = [];
	for (const r of results) {
		if (!r.ok) continue;
		if (r.name.startsWith("FMP")) continue;
		viable.push(`  - ${r.name}`);
	}
	console.log(viable.join("\n"));

	console.log("\nRecommendation: combine SEC EDGAR companyfacts (sharesOutstanding) with Yahoo chart");
	console.log("(current price) to derive marketCapUsd. EDGAR submissions gives exchange + former names.");
	console.log("IPO date via dedicated S-1 filing lookup if needed.");
}

await main();
