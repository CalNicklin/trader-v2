#!/usr/bin/env bun
/**
 * UK-only smoke test for the universe pipeline.
 *
 * Runs ONLY the UK path (iShares ISF + Wikipedia FTSE 250 + curated AIM +
 * Yahoo UK enricher + Frankfurter FX) against :memory: DB. Does not touch
 * Russell 1000, EDGAR, or any US code path. Useful for:
 *
 *   - Verifying PR #37 works independently of the US stack
 *   - Fast UK-focused regression check (~15s)
 *   - Confidence before reverting / changing the US stack
 *
 * Usage:  bun scripts/uk-pipeline-smoke-test.ts
 */

process.env.DB_PATH = ":memory:";
process.env.FMP_API_KEY ??= "test-smoke-test";
process.env.RESEND_API_KEY ??= "test-smoke-test";
process.env.ALERT_EMAIL_TO ??= "test@example.com";
process.env.ANTHROPIC_API_KEY ??= "test-smoke-test";
process.env.FINNHUB_API_KEY ??= "test-smoke-test";

const { getDb, closeDb } = await import("../src/db/client.ts");
const { investableUniverse } = await import("../src/db/schema.ts");
const { refreshInvestableUniverse } = await import("../src/universe/refresh.ts");
const { applyLiquidityFilters } = await import("../src/universe/filters.ts");
const { fetchFtse350Combined } = await import("../src/universe/sources/ftse-350-combined.ts");
const { fetchAimCurated } = await import("../src/universe/sources/aim-curated.ts");
const { fetchYahooUkQuotes } = await import("../src/universe/enrichers/yahoo-uk.ts");
const { eq } = await import("drizzle-orm");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

const EXPECTED = {
	ftse_350: {
		preFilter: 280, // ISF ~100 + Wikipedia ~248 minus dedup/parse-noise
		postFilter: 150, // At $5M $ADV, ~half of FTSE 350 passes
	},
	aim_allshare: {
		preFilter: 5, // hand-curated whitelist
		postFilter: 1, // GAW alone clears $5M $ADV in the last runs
	},
};

async function main() {
	const started = Date.now();
	console.log("UK pipeline smoke test — UK sources only (no US/EDGAR)\n");

	closeDb();
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
	console.log("✓ Migrations applied");

	// Stage 1: Fetch UK constituents only
	console.log("\n── Stage 1: UK constituents ──");
	const t1 = Date.now();
	const [ftse350, aim] = await Promise.all([fetchFtse350Combined(), fetchAimCurated()]);
	console.log(`  FTSE 350 (ISF + Wikipedia): ${ftse350.length} (${Date.now() - t1}ms)`);
	console.log(`  AIM (curated): ${aim.length}`);

	let fail = 0;
	if (ftse350.length < EXPECTED.ftse_350.preFilter) {
		console.log(
			`  ✗ ftse_350 pre-filter: ${ftse350.length} < ${EXPECTED.ftse_350.preFilter}`,
		);
		fail++;
	} else {
		console.log(`  ✓ ftse_350 pre-filter: ${ftse350.length} (>= ${EXPECTED.ftse_350.preFilter})`);
	}
	if (aim.length < EXPECTED.aim_allshare.preFilter) {
		console.log(`  ✗ aim pre-filter: ${aim.length} < ${EXPECTED.aim_allshare.preFilter}`);
		fail++;
	} else {
		console.log(`  ✓ aim pre-filter: ${aim.length} (>= ${EXPECTED.aim_allshare.preFilter})`);
	}

	// Stage 2: Yahoo UK enrichment
	console.log("\n── Stage 2: Yahoo UK enrichment ──");
	const t2 = Date.now();
	const allUk = [...ftse350, ...aim];
	const yahooQuotes = await fetchYahooUkQuotes(allUk);
	console.log(
		`  ${yahooQuotes.size} / ${allUk.length} UK symbols fetched in ${Date.now() - t2}ms`,
	);
	console.log(`  Hit rate: ${((yahooQuotes.size / allUk.length) * 100).toFixed(1)}%`);

	// Stage 3: Project the would-be filter inputs
	console.log("\n── Stage 3: Simulated filter input ──");
	const candidates = allUk.map((row) => {
		const q = yahooQuotes.get(`${row.symbol}:${row.exchange}`);
		return {
			...row,
			marketCapUsd: null,
			avgDollarVolume: q?.avgDollarVolumeUsd ?? null,
			price: q?.priceGbpPence ?? null,
			freeFloatUsd: null,
			spreadBps: null,
			listingAgeDays: null,
		};
	});
	const filter = applyLiquidityFilters(candidates);
	console.log(`  passed: ${filter.passed.length}, rejected: ${filter.rejected.length}`);

	const bySource: Record<string, number> = {};
	for (const c of filter.passed) bySource[c.indexSource] = (bySource[c.indexSource] ?? 0) + 1;
	console.log(`  By source (post-filter):`, bySource);

	const rejectReasons: Record<string, number> = {};
	for (const r of filter.rejected) {
		for (const reason of r.reasons) rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
	}
	console.log(`  Reject reasons:`, rejectReasons);

	const ftsePassed = bySource.ftse_350 ?? 0;
	const aimPassed = bySource.aim_allshare ?? 0;
	if (ftsePassed < EXPECTED.ftse_350.postFilter) {
		console.log(
			`  ✗ ftse_350 post-filter: ${ftsePassed} < ${EXPECTED.ftse_350.postFilter}`,
		);
		fail++;
	} else {
		console.log(
			`  ✓ ftse_350 post-filter: ${ftsePassed} (>= ${EXPECTED.ftse_350.postFilter})`,
		);
	}
	if (aimPassed < EXPECTED.aim_allshare.postFilter) {
		console.log(`  ✗ aim post-filter: ${aimPassed} < ${EXPECTED.aim_allshare.postFilter}`);
		fail++;
	} else {
		console.log(`  ✓ aim post-filter: ${aimPassed} (>= ${EXPECTED.aim_allshare.postFilter})`);
	}

	// Stage 4: Full refresh (upsert path works)
	console.log("\n── Stage 4: Full refresh upsert ──");
	const refresh = await refreshInvestableUniverse({
		fetchCandidates: async () => candidates,
		snapshotDate: new Date().toISOString().slice(0, 10),
	});
	console.log(`  added: ${refresh.added}, removed: ${refresh.removed}, rejected: ${refresh.rejected}`);

	const dbRows = await db
		.select()
		.from(investableUniverse)
		.where(eq(investableUniverse.active, true))
		.all();
	console.log(`  DB rows active: ${dbRows.length}`);

	// Stage 5: Sample data quality for UK rows
	console.log("\n── Stage 5: UK sample data quality ──");
	const topUk = dbRows.filter((r) => r.exchange === "LSE" || r.exchange === "AIM").slice(0, 8);
	for (const r of topUk) {
		const priceDisplay = r.price != null ? `${r.price}GBp` : "null";
		const advDisplay = r.avgDollarVolume != null ? `$${(r.avgDollarVolume / 1e6).toFixed(1)}M` : "null";
		console.log(`  ${r.symbol} (${r.indexSource}): price=${priceDisplay}, $ADV=${advDisplay}`);
	}

	// Verdict
	console.log(`\n── Summary ──`);
	console.log(`  Total time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
	if (fail === 0) {
		console.log(`  ✅ UK pipeline green. PR #37 works standalone.`);
		process.exit(0);
	} else {
		console.log(`  ❌ ${fail} UK expectation(s) failed.`);
		process.exit(1);
	}
}

await main();
