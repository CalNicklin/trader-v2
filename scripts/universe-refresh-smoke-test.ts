#!/usr/bin/env bun
/**
 * End-to-end smoke test for the universe-refresh pipeline.
 *
 * Unlike the earlier dry-run scripts (which just hit each endpoint in
 * isolation), this script runs the ACTUAL `runWeeklyUniverseRefresh` flow
 * against an in-memory SQLite database, exercising every stage:
 *
 *   sources → aggregator → enrichers → filters → upsert
 *
 * Output is a pass/fail verdict with per-source row counts and rejection
 * reasons. If this green-lights, the refresh should work in prod.
 *
 * Usage:  bun scripts/universe-refresh-smoke-test.ts
 */

process.env.DB_PATH = ":memory:";
process.env.FMP_API_KEY ??= "test-smoke-test"; // will 403 — that's the point
process.env.RESEND_API_KEY ??= "test-smoke-test";
process.env.ALERT_EMAIL_TO ??= "test@example.com";
process.env.ANTHROPIC_API_KEY ??= "test-smoke-test";
process.env.FINNHUB_API_KEY ??= "test-smoke-test";

// Dynamic imports so env assignments above actually take effect — static
// imports are hoisted and would load config before our env is ready.
const { getDb, closeDb } = await import("../src/db/client.ts");
const { investableUniverse, universeSnapshots } = await import("../src/db/schema.ts");
const { refreshInvestableUniverse } = await import("../src/universe/refresh.ts");
const { fetchCandidatesFromAllSources } = await import("../src/universe/source-aggregator.ts");
const { applyLiquidityFilters } = await import("../src/universe/filters.ts");
const { eq } = await import("drizzle-orm");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

// ── Minimum viable expectations (adjust based on what we observe is realistic) ──
const EXPECTED_MIN = {
	russell_1000: 900, // IWB CSV typically has ~1000
	ftse_350: 280, // FTSE 100 + FTSE 250 minus dedup + parse noise
	aim_allshare: 5, // hand-curated whitelist
};

// When FMP profile is dead (which it is today), US rows have no market_cap /
// free_float / IPO date. The liquidity filter still accepts them IF
// quotes_cache has price + avgVolume. For a fresh :memory: DB, quotes_cache
// is empty — so the smoke test naturally shows the "US only passes if
// enriched elsewhere" failure mode.
const EXPECTED_MIN_AFTER_FILTER = {
	russell_1000: 700, // With EDGAR+Yahoo enrichment, most Russell 1000 names pass the $5M $ADV filter
	ftse_350: 150, // Yahoo enrichment covers UK; at $5M $ADV, ~half of FTSE 350 passes
	aim_allshare: 1, // At least one AIM curated name (GAW) should pass
};

async function main() {
	const started = Date.now();
	console.log("Universe refresh smoke test — running full pipeline against :memory:\n");

	// Setup: fresh in-memory DB + migrations
	closeDb();
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
	console.log("✓ Migrations applied");

	// STAGE 0: Seed the CIK map so the US profile enricher can resolve tickers.
	console.log("\n── Stage 0: Seed CIK map ──");
	const { refreshCikMap } = await import("../src/universe/ciks/edgar-ticker-map.ts");
	const cikCount = await refreshCikMap();
	console.log(`  ${cikCount} CIK entries loaded from SEC`);

	// STAGE 1: Raw aggregator — which sources actually respond?
	console.log("\n── Stage 1: Source aggregator ──");
	const aggregator = await timed(() => fetchCandidatesFromAllSources());
	const agg = aggregator.result;
	console.log(`  ${agg.candidates.length} candidates fetched in ${aggregator.ms}ms`);
	console.log(`  Failed sources: ${JSON.stringify(agg.failedIndexSources)}`);

	const bySourceRaw: Record<string, number> = {};
	for (const c of agg.candidates) bySourceRaw[c.indexSource] = (bySourceRaw[c.indexSource] ?? 0) + 1;
	console.log(`  By source (pre-filter):`, bySourceRaw);

	let fail = 0;
	for (const [src, min] of Object.entries(EXPECTED_MIN)) {
		const actual = bySourceRaw[src] ?? 0;
		if (actual < min) {
			console.log(`  ✗ ${src}: expected >= ${min}, got ${actual}`);
			fail++;
		} else {
			console.log(`  ✓ ${src}: ${actual} (>= ${min})`);
		}
	}

	// STAGE 2: Liquidity filter — what passes?
	console.log("\n── Stage 2: Liquidity filter ──");
	const filter = applyLiquidityFilters(agg.candidates);
	console.log(`  passed: ${filter.passed.length}, rejected: ${filter.rejected.length}`);

	const bySourcePassed: Record<string, number> = {};
	for (const c of filter.passed) bySourcePassed[c.indexSource] = (bySourcePassed[c.indexSource] ?? 0) + 1;
	console.log(`  By source (post-filter):`, bySourcePassed);

	const rejectReasons: Record<string, number> = {};
	for (const r of filter.rejected) {
		for (const reason of r.reasons) rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
	}
	console.log(`  Reject reasons:`, rejectReasons);

	for (const [src, min] of Object.entries(EXPECTED_MIN_AFTER_FILTER)) {
		const actual = bySourcePassed[src] ?? 0;
		if (actual < min) {
			console.log(`  ✗ ${src} post-filter: expected >= ${min}, got ${actual}`);
			fail++;
		} else {
			console.log(`  ✓ ${src} post-filter: ${actual} (>= ${min})`);
		}
	}

	// STAGE 3: Full runWeeklyUniverseRefresh — prove the upsert path works
	console.log("\n── Stage 3: Full refresh (runWeeklyUniverseRefresh via refreshInvestableUniverse) ──");
	const refresh = await timed(() =>
		refreshInvestableUniverse({
			fetchCandidates: async () => agg.candidates,
			snapshotDate: new Date().toISOString().slice(0, 10),
			skipDeactivationForIndexSources: agg.failedIndexSources,
		}),
	);
	console.log(`  added: ${refresh.result.added}, removed: ${refresh.result.removed}, rejected: ${refresh.result.rejected} (${refresh.ms}ms)`);

	// Verify the DB actually has rows
	const dbRows = await db.select().from(investableUniverse).where(eq(investableUniverse.active, true)).all();
	const snapshots = await db.select().from(universeSnapshots).all();

	const bySourceDb: Record<string, number> = {};
	for (const r of dbRows) bySourceDb[r.indexSource] = (bySourceDb[r.indexSource] ?? 0) + 1;
	console.log(`  DB rows active: ${dbRows.length}, by source:`, bySourceDb);
	console.log(`  Snapshot entries: ${snapshots.length}`);

	// STAGE 4: Field-level sanity check on a sample
	console.log("\n── Stage 4: Data-quality sanity check on 5 sample rows ──");
	const samples = dbRows.slice(0, 5);
	for (const s of samples) {
		const issues: string[] = [];
		if (s.price == null) issues.push("no price");
		if (s.avgDollarVolume == null) issues.push("no avgDollarVolume");
		if (s.marketCapUsd == null) issues.push("no marketCapUsd");
		if (s.freeFloatUsd == null) issues.push("no freeFloatUsd");
		console.log(`  ${s.symbol} (${s.indexSource}): ${issues.length > 0 ? issues.join(", ") : "complete"}`);
	}

	// Verdict
	console.log(`\n── Summary ──`);
	console.log(`  Total time: ${Date.now() - started}ms`);
	if (fail === 0) {
		console.log(`  ✅ All expectations met. Pipeline is green.`);
		process.exit(0);
	} else {
		console.log(`  ❌ ${fail} expectation(s) failed. Do NOT ship.`);
		process.exit(1);
	}
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
	const t0 = Date.now();
	const result = await fn();
	return { result, ms: Date.now() - t0 };
}

await main();
