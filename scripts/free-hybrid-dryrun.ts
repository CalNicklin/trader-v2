#!/usr/bin/env bun
/**
 * Hybrid free-stack dry-run.
 *
 * Proves the UK side of Option 3: fetch UK constituents from free sources
 * (iShares ISF + Wikipedia FTSE 250) and, for a sample of those names, pull
 * the liquidity-filter inputs (price, volume, estimated market cap in USD)
 * from Yahoo Finance. Reports what would pass our existing filter thresholds.
 *
 * Writes nothing to the DB. Safe to re-run.
 *
 * Usage:  bun scripts/free-hybrid-dryrun.ts
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Filter thresholds (mirror src/universe/constants.ts — hard-coded here to keep
// this script dependency-free so it can be run in isolation)
const AVG_DOLLAR_VOLUME_USD_MIN = 5_000_000;
const PRICE_GBP_MIN = 1.0; // 100p

// Sample size: pull Yahoo chart for the top N FTSE 100 names + a handful of
// FTSE 250 + AIM names. Keeping it small so this script stays under 30s.
const UK_SAMPLE_SIZE = 30;

interface UkCandidate {
	symbol: string; // Our canonical symbol (no .L suffix)
	yahooSymbol: string; // Yahoo ticker (.L)
	indexSource: "ftse_100" | "ftse_250" | "aim_curated";
	name?: string;
}

interface YahooBar {
	close: number;
	volume: number;
}

interface EnrichedCandidate extends UkCandidate {
	priceGbp: number;
	avgVolume30d: number;
	avgDollarVolumeUsd: number;
	currency: string;
	passes: {
		price: boolean;
		adv: boolean;
		overall: boolean;
	};
	error?: string;
}

const log = (...args: unknown[]) => console.log(...args);

// ── Step 1: fetch FTSE 100 from iShares ISF CSV ───────────────────────────────
async function fetchFTSE100(): Promise<UkCandidate[]> {
	const url =
		"https://www.ishares.com/uk/individual/en/products/251795/ishares-core-ftse-100-ucits-etf/1506575576011.ajax?fileType=csv&fileName=ISF_holdings&dataType=fund";
	const res = await fetch(url, { headers: { "User-Agent": UA } });
	if (!res.ok) throw new Error(`ISF fetch failed: HTTP ${res.status}`);
	const csv = await res.text();
	const lines = csv.split("\n");
	const headerIdx = lines.findIndex((l) => l.startsWith("Ticker,"));
	if (headerIdx < 0) throw new Error("ISF CSV header not found");
	const rows = lines
		.slice(headerIdx + 1)
		.filter((l) => l.trim().startsWith('"'))
		.map((l) => {
			const cells = l.split('","').map((c) => c.replace(/^"|"$/g, ""));
			return { ticker: cells[0], name: cells[1], assetClass: cells[3] };
		})
		.filter((r) => r.assetClass === "Equity" && r.ticker);
	return rows.map((r) => ({
		symbol: r.ticker!,
		yahooSymbol: `${normaliseYahooSymbol(r.ticker!)}.L`,
		indexSource: "ftse_100" as const,
		name: r.name,
	}));
}

// Note: the iShares-path uses normaliseYahooSymbol via the map above.

function normaliseYahooSymbol(rawSymbol: string): string {
	// iShares + Wikipedia include trailing dots for share-class indicators
	// ("BP.", "RR."). Yahoo wants "BP.L" — strip the trailing dot before
	// appending the exchange suffix.
	return rawSymbol.replace(/\.$/, "");
}

// ── Step 2: fetch FTSE 250 from Wikipedia ─────────────────────────────────────
async function fetchFTSE250(): Promise<UkCandidate[]> {
	const res = await fetch("https://en.wikipedia.org/wiki/FTSE_250_Index", {
		headers: { "User-Agent": UA },
	});
	if (!res.ok) throw new Error(`Wiki FTSE 250 fetch failed: HTTP ${res.status}`);
	const html = await res.text();
	// Wikipedia's FTSE 250 constituents table has columns: Company / EPIC / Index weighting / Sector.
	// EPIC codes appear as `<td>ABDN</td>` or `<td><a href="...">ABDN</a></td>`.
	const tickerPattern = /<td[^>]*>(?:<a[^>]*>)?([A-Z]{2,4}\.?[A-Z]?)(?:<\/a>)?<\/td>/g;
	const found = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = tickerPattern.exec(html)) !== null) {
		const t = m[1];
		if (t && t.length >= 2) found.add(t);
	}
	// Filter Wikipedia noise: the table-cell regex catches non-EPIC cells. Real
	// FTSE 250 EPICs are present, but so are column headers like "MCX" that
	// aren't tradeable tickers. We filter out a small known-bad set; broader
	// validation happens when Yahoo returns 404 (we log those as errors, not
	// as legitimate candidates).
	const KNOWN_NOISE = new Set(["MCX", "EPS", "EPIC", "FTSE"]);
	return [...found]
		.filter((t) => !KNOWN_NOISE.has(t))
		.map((t) => ({
			symbol: t,
			yahooSymbol: `${normaliseYahooSymbol(t)}.L`,
			indexSource: "ftse_250" as const,
		}));
}

// ── Step 3: hand-curated AIM names (the ones we actually care about) ─────────
function aimCurated(): UkCandidate[] {
	return [
		{ symbol: "GAW", name: "Games Workshop", yahooSymbol: "GAW.L", indexSource: "aim_curated" },
		{ symbol: "FDEV", name: "Frontier Developments", yahooSymbol: "FDEV.L", indexSource: "aim_curated" },
		{ symbol: "TET", name: "Treatt", yahooSymbol: "TET.L", indexSource: "aim_curated" },
		{ symbol: "JET2", name: "Jet2 plc", yahooSymbol: "JET2.L", indexSource: "aim_curated" },
		{ symbol: "BOWL", name: "Hollywood Bowl", yahooSymbol: "BOWL.L", indexSource: "aim_curated" },
	];
}

// ── Step 4: Yahoo chart — price + 30-day avg volume ──────────────────────────
async function fetchYahooChart(yahooSymbol: string): Promise<{
	priceGbp: number;
	avgVolume30d: number;
	currency: string;
} | { error: string }> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=30d`;
	try {
		const res = await fetch(url, { headers: { "User-Agent": UA } });
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const data = (await res.json()) as {
			chart: {
				result?: Array<{
					meta: { regularMarketPrice: number; currency: string };
					indicators: { quote: Array<{ close: (number | null)[]; volume: (number | null)[] }> };
				}>;
				error?: { code: string; description: string };
			};
		};
		if (data.chart.error) return { error: data.chart.error.description };
		const result = data.chart.result?.[0];
		if (!result) return { error: "no result" };

		const closes = result.indicators.quote[0]?.close ?? [];
		const volumes = result.indicators.quote[0]?.volume ?? [];
		const validVolumes = volumes.filter((v): v is number => typeof v === "number" && v > 0);
		if (validVolumes.length === 0) return { error: "no volume data" };

		const avgVolume30d = validVolumes.reduce((a, b) => a + b, 0) / validVolumes.length;
		const priceGbp = result.meta.regularMarketPrice;

		return {
			priceGbp,
			avgVolume30d,
			currency: result.meta.currency, // usually "GBp" (pence)
		};
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

// ── Step 5: GBP→USD FX via Frankfurter ────────────────────────────────────────
async function fetchFx(): Promise<number> {
	const res = await fetch("https://api.frankfurter.dev/v1/latest?from=GBP&to=USD");
	if (!res.ok) throw new Error(`FX fetch failed: HTTP ${res.status}`);
	const data = (await res.json()) as { rates: { USD: number } };
	return data.rates.USD;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
	log("Hybrid free-stack dry-run — UK path\n");

	// 5a. Fetch constituents
	log("1. Fetching constituent lists...");
	const [ftse100, ftse250, aim, gbpUsd] = await Promise.all([
		fetchFTSE100(),
		fetchFTSE250(),
		Promise.resolve(aimCurated()),
		fetchFx(),
	]);
	log(`   FTSE 100: ${ftse100.length} names`);
	log(`   FTSE 250: ${ftse250.length} names`);
	log(`   AIM (hand-curated): ${aim.length} names`);
	log(`   GBP→USD FX: ${gbpUsd}`);

	const allUk = [...ftse100, ...ftse250, ...aim];
	const dedup = new Map<string, UkCandidate>();
	for (const c of allUk) dedup.set(c.yahooSymbol, c);
	const combined = [...dedup.values()];
	log(`   Combined unique UK candidates: ${combined.length}\n`);

	// 5b. Pick a sample — FTSE 100 (top 10) + FTSE 250 (10 random) + AIM all
	const sample: UkCandidate[] = [
		...ftse100.slice(0, 10),
		...ftse250.slice(0, Math.min(15, ftse250.length)),
		...aim,
	];
	// Dedup within the sample
	const sampleSet = new Map<string, UkCandidate>();
	for (const c of sample) sampleSet.set(c.yahooSymbol, c);
	const uniqueSample = [...sampleSet.values()].slice(0, UK_SAMPLE_SIZE);

	log(`2. Pulling Yahoo chart data for ${uniqueSample.length} sample UK names...`);

	// 5c. Enrich via Yahoo — throttle to 4 concurrent to be polite
	const enriched: EnrichedCandidate[] = [];
	const batchSize = 4;
	for (let i = 0; i < uniqueSample.length; i += batchSize) {
		const batch = uniqueSample.slice(i, i + batchSize);
		const batchResults = await Promise.all(
			batch.map(async (c) => {
				const chart = await fetchYahooChart(c.yahooSymbol);
				if ("error" in chart) {
					return {
						...c,
						priceGbp: 0,
						avgVolume30d: 0,
						avgDollarVolumeUsd: 0,
						currency: "?",
						passes: { price: false, adv: false, overall: false },
						error: chart.error,
					};
				}
				// Yahoo returns UK prices in GBp (pence). Convert to GBP then USD.
				const priceInGbp = chart.currency === "GBp" ? chart.priceGbp / 100 : chart.priceGbp;
				const avgDollarVolumeUsd = priceInGbp * gbpUsd * chart.avgVolume30d;
				const pricePass = priceInGbp >= PRICE_GBP_MIN;
				const advPass = avgDollarVolumeUsd >= AVG_DOLLAR_VOLUME_USD_MIN;
				return {
					...c,
					priceGbp: priceInGbp,
					avgVolume30d: chart.avgVolume30d,
					avgDollarVolumeUsd,
					currency: chart.currency,
					passes: {
						price: pricePass,
						adv: advPass,
						overall: pricePass && advPass,
					},
				} as EnrichedCandidate;
			}),
		);
		enriched.push(...batchResults);
	}

	// 5d. Report
	log(
		`\n${"Symbol".padEnd(10)}${"Source".padEnd(14)}${"Price(GBP)".padEnd(12)}${"30d AvgVol".padEnd(14)}${"$ADV(USD)".padEnd(16)}${"Price".padEnd(8)}${"ADV".padEnd(6)}Pass?`,
	);
	log("─".repeat(90));
	for (const e of enriched) {
		if (e.error) {
			log(`${e.symbol.padEnd(10)}${e.indexSource.padEnd(14)}ERROR: ${e.error}`);
			continue;
		}
		const fmt = (n: number) =>
			n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n.toFixed(0);
		log(
			`${e.symbol.padEnd(10)}${e.indexSource.padEnd(14)}${e.priceGbp.toFixed(2).padEnd(12)}${fmt(e.avgVolume30d).padEnd(14)}$${fmt(e.avgDollarVolumeUsd).padEnd(15)}${(e.passes.price ? "✓" : "✗").padEnd(8)}${(e.passes.adv ? "✓" : "✗").padEnd(6)}${e.passes.overall ? "✅" : "❌"}`,
		);
	}

	// 5e. Summary stats
	const totalOk = enriched.filter((e) => !e.error).length;
	const totalPass = enriched.filter((e) => e.passes.overall).length;
	const totalFail = enriched.filter((e) => !e.passes.overall && !e.error).length;
	const totalErr = enriched.filter((e) => e.error).length;

	log(`\n─────────────────────────────────`);
	log(`Sample results:`);
	log(`  ${totalOk}/${enriched.length} fetched successfully from Yahoo`);
	log(`  ${totalPass} pass full liquidity filter ($ADV≥$${AVG_DOLLAR_VOLUME_USD_MIN / 1e6}M + price≥${PRICE_GBP_MIN}GBP)`);
	log(`  ${totalFail} fail filter (e.g. thin AIM names, low liquidity)`);
	if (totalErr > 0) log(`  ${totalErr} errored out`);

	const passRate = totalOk > 0 ? ((totalPass / totalOk) * 100).toFixed(0) : "0";
	log(`\nProjected universe size (assuming ${passRate}% pass rate holds):`);
	log(`  Full UK universe after filter: ~${Math.round((combined.length * totalPass) / Math.max(totalOk, 1))}`);
	log(`  (sample-based estimate — real number depends on broader AIM coverage)`);

	log(`\nGaps NOT covered by this hybrid stack:`);
	log(`  - Full AIM All-Share (only hand-curated list here)`);
	log(`  - UK fundamentals (market cap, free float, IPO date) — Yahoo v10 needs crumb dance`);
	log(`  - UK earnings calendar — not in any free source`);

	log(`\nUS path unchanged: FMP continues to work for US constituents, profile, quotes, earnings, news.`);
}

await main();
