#!/usr/bin/env bun
/**
 * Smoke test for the FMP removal PR.
 *
 * Exercises each swapped call site against live endpoints. Must pass before
 * the PR is opened. Catches the "I thought this worked but it's silently
 * returning null" class of bug that bit us in PR #37 and PR #40.
 *
 * Usage: bun scripts/fmp-removal-smoke-test.ts
 */

process.env.DB_PATH = ":memory:";
process.env.FMP_API_KEY ??= "removed-but-config-still-requires";
process.env.RESEND_API_KEY ??= "smoke";
process.env.ALERT_EMAIL_TO ??= "smoke@example.com";
process.env.ANTHROPIC_API_KEY ??= "smoke";
process.env.FINNHUB_API_KEY ??= "smoke";

const { yahooUsQuote, yahooUsHistorical } = await import("../src/data/yahoo-us.ts");
const { fetchYahooRssUk } = await import("../src/news/yahoo-rss-uk.ts");
const { getExchangeRate } = await import("../src/utils/fx.ts");

interface Check {
	name: string;
	pass: boolean;
	detail: string;
}
const checks: Check[] = [];

function record(name: string, pass: boolean, detail: string) {
	checks.push({ name, pass, detail });
	console.log(`${pass ? "✅" : "❌"} ${name}: ${detail}`);
}

// 1. US quote
const aapl = await yahooUsQuote("AAPL", "NASDAQ");
record(
	"yahooUsQuote(AAPL)",
	aapl != null && aapl.last != null && aapl.volume != null,
	aapl ? `last=${aapl.last}, vol=${aapl.volume}, avgVol=${aapl.avgVolume?.toFixed(0) ?? "?"}` : "null",
);

// 2. US historical (30 days)
const aaplBars = await yahooUsHistorical("AAPL", "NASDAQ", 30);
record(
	"yahooUsHistorical(AAPL, 30d)",
	Array.isArray(aaplBars) && aaplBars.length >= 15,
	`${aaplBars?.length ?? 0} bars`,
);

// 3. UK RSS
const bpItems = await fetchYahooRssUk("BP", "LSE");
record(
	"fetchYahooRssUk(BP.L)",
	bpItems.length >= 1,
	`${bpItems.length} items; first: "${bpItems[0]?.title.slice(0, 60) ?? "?"}"`,
);

// 4. FX via Frankfurter
const gbpUsd = await getExchangeRate("GBP", "USD");
record(
	"getExchangeRate(GBP, USD)",
	gbpUsd > 1.0 && gbpUsd < 2.0,
	`rate=${gbpUsd}`,
);

// 5. No lingering FMP imports in src/ (active code, not comments)
const { execSync } = await import("node:child_process");
const leaks = execSync(
	"grep -rn 'fmpFetch\\|fmpQuote\\|fmpHistorical\\|fmpFxRate\\|fmpValidateSymbol\\|fmpResolveExchange\\|fmpBatchQuotes\\|fetchFmpCompanyNews\\|financialmodelingprep\\|toFmpSymbol\\|normalizeFmpExchange' src/ --include='*.ts' 2>/dev/null || true",
	{ encoding: "utf8" },
).trim();
record(
	"No FMP imports or URLs in src/",
	leaks.length === 0,
	leaks.length === 0 ? "clean" : `${leaks.split("\n").length} lines with FMP references:\n${leaks}`,
);

const passed = checks.filter((c) => c.pass).length;
console.log(`\n── Summary: ${passed}/${checks.length} checks passed ──`);
if (passed < checks.length) {
	console.log("\nFailures:");
	for (const c of checks.filter((c) => !c.pass)) console.log(`  - ${c.name}: ${c.detail}`);
	process.exit(1);
}
console.log("\n✅ FMP-removal smoke test green. Safe to delete FMP client in Task 13.");
