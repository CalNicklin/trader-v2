# Canonical Exchange Resolution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the silent `"NASDAQ"` default for bare-symbol universe specs and clean up the resulting orphaned `news_analyses` rows so every (symbol, exchange) tuple in the news pipeline is canonically correct.

**Architecture:** Add a deterministic `resolveExchange(symbol)` helper backed by FMP `/profile` (we already use this endpoint for `fmpValidateSymbol`). Replace the `[spec, "NASDAQ"]` defaults in `buildUniverseWhitelist` (`src/news/research-agent.ts:206`) and `filterUniverseByExchanges` (`src/scheduler/strategy-eval-job.ts:21`) with this resolver. Run a one-shot migration on the VPS to rewrite `news_analyses.exchange` (and dedupe `quotes_cache`) to canonical values for the 12 affected symbols (JPM, V, JNJ, CRM, SPOT, BYD, LPL, SSNLF, AZN, SHEL, SAMSUNG, PANASONIC).

**Tech Stack:** Bun, TypeScript, Drizzle ORM, SQLite (`bun:sqlite`), FMP `/profile` API, existing in-memory TTL cache pattern from `fmpValidateSymbol`.

---

## Background

The current bug (root-caused this session):

```ts
// src/news/research-agent.ts:206 and src/scheduler/strategy-eval-job.ts:21
const [sym, ex] = spec.includes(":") ? spec.split(":") : [spec, "NASDAQ"];
```

Strategy universes hold bare strings like `"JPM"`, `"V"`, `"JNJ"`, `"CRM"` — all genuinely NYSE listings. Both call sites silently default them to `NASDAQ`. The whitelist hands the LLM `"JPM (exchange: NASDAQ)"`, the LLM echoes NASDAQ, and `news_analyses.exchange = "NASDAQ"`. Pre-Apr-10 history (RSS+RNS pipeline) wrote NYSE labels for the same symbols, so 24h-window aggregation can read either set depending on which exchange the eval job queries with.

DB evidence: 12 symbols have analyses split across two exchanges, all flipping at the FMP migration boundary `2026-04-10T13:00Z`.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/data/fmp.ts` | New `fmpResolveExchange(symbol)` — calls `/profile`, normalizes FMP exchange strings to our `Exchange` enum, in-memory TTL cache (mirrors `fmpValidateSymbol`). |
| `src/news/exchange-resolver.ts` | New module wrapping `fmpResolveExchange` with a sync-friendly `parseUniverseSpec(spec)` async helper that returns `{symbol, exchange}`. Single source of truth used by both consumers below. |
| `src/news/research-agent.ts` | Replace the `[spec, "NASDAQ"]` default in `buildUniverseWhitelist` (around line 206) with `parseUniverseSpec`. |
| `src/scheduler/strategy-eval-job.ts` | Replace the `[, "NASDAQ"]` default in `filterUniverseByExchanges` (around line 21) with `parseUniverseSpec` (or its sync subset — see Task 3). |
| `scripts/migrate-canonical-exchange.ts` | One-shot migration. Resolves canonical exchange per affected symbol, UPDATEs `news_analyses` rows, deletes/dedupes duplicate `quotes_cache` rows. Idempotent. |
| `tests/data/fmp-resolve-exchange.test.ts` | Tests for the FMP normalizer + cache. |
| `tests/news/exchange-resolver.test.ts` | Tests for `parseUniverseSpec` (explicit suffix wins; bare → resolver; unknown symbol surfaces error). |
| `tests/news/research-agent.test.ts` *(modify)* | Update existing whitelist-related assertions to expect canonical exchanges. |
| `tests/scheduler/strategy-eval-job.test.ts` *(modify)* | Update `filterUniverseByExchanges` assertions. |

## FMP exchange-string normalization

FMP `/profile.exchange` returns strings like:
- `"NASDAQ Global Select"`, `"NASDAQ Global Market"`, `"NASDAQ Capital Market"` → `"NASDAQ"`
- `"New York Stock Exchange"`, `"NYSE American"`, `"NYSE Arca"` → `"NYSE"`
- `"London Stock Exchange"` → `"LSE"`
- Anything else → throw (caller decides — typically log+skip).

This map is small and fixed; embed it in `src/data/fmp.ts`.

---

### Task 1: FMP exchange resolver

**Files:**
- Modify: `src/data/fmp.ts` (append after `fmpValidateSymbol`)
- Test: `tests/data/fmp-resolve-exchange.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/data/fmp-resolve-exchange.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	_resetExchangeResolverCache,
	fmpResolveExchange,
	normalizeFmpExchange,
} from "../../src/data/fmp.ts";

describe("normalizeFmpExchange", () => {
	test("maps NASDAQ variants", () => {
		expect(normalizeFmpExchange("NASDAQ Global Select")).toBe("NASDAQ");
		expect(normalizeFmpExchange("NASDAQ Global Market")).toBe("NASDAQ");
		expect(normalizeFmpExchange("NASDAQ Capital Market")).toBe("NASDAQ");
	});
	test("maps NYSE variants", () => {
		expect(normalizeFmpExchange("New York Stock Exchange")).toBe("NYSE");
		expect(normalizeFmpExchange("NYSE American")).toBe("NYSE");
		expect(normalizeFmpExchange("NYSE Arca")).toBe("NYSE");
	});
	test("maps LSE", () => {
		expect(normalizeFmpExchange("London Stock Exchange")).toBe("LSE");
	});
	test("returns null for unrecognized exchange", () => {
		expect(normalizeFmpExchange("Tokyo Stock Exchange")).toBeNull();
		expect(normalizeFmpExchange("")).toBeNull();
	});
});

describe("fmpResolveExchange", () => {
	beforeEach(() => {
		_resetExchangeResolverCache();
	});

	test("returns canonical exchange for a symbol", async () => {
		const fetchMock = mock(async () => [
			{ symbol: "JPM", exchange: "New York Stock Exchange", isActivelyTrading: true },
		]);
		const result = await fmpResolveExchange("JPM", { fetch: fetchMock });
		expect(result).toBe("NYSE");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("caches the result across calls", async () => {
		const fetchMock = mock(async () => [
			{ symbol: "AAPL", exchange: "NASDAQ Global Select", isActivelyTrading: true },
		]);
		await fmpResolveExchange("AAPL", { fetch: fetchMock });
		await fmpResolveExchange("AAPL", { fetch: fetchMock });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("returns null when FMP returns empty", async () => {
		const fetchMock = mock(async () => []);
		const result = await fmpResolveExchange("XYZNOTREAL", { fetch: fetchMock });
		expect(result).toBeNull();
	});

	test("returns null when exchange string is unrecognized", async () => {
		const fetchMock = mock(async () => [
			{ symbol: "7203.T", exchange: "Tokyo Stock Exchange", isActivelyTrading: true },
		]);
		const result = await fmpResolveExchange("7203.T", { fetch: fetchMock });
		expect(result).toBeNull();
	});

	test("fail-closed on network error", async () => {
		const fetchMock = mock(async () => {
			throw new Error("ECONNRESET");
		});
		const result = await fmpResolveExchange("JPM", { fetch: fetchMock });
		expect(result).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/data/fmp-resolve-exchange.test.ts`
Expected: FAIL with "fmpResolveExchange is not exported" (or similar).

- [ ] **Step 3: Implement resolver in `src/data/fmp.ts`**

Append after `fmpValidateSymbol` (around line 347):

```ts
const EXCHANGE_NORMALIZATION: Record<string, "NASDAQ" | "NYSE" | "LSE"> = {
	"NASDAQ Global Select": "NASDAQ",
	"NASDAQ Global Market": "NASDAQ",
	"NASDAQ Capital Market": "NASDAQ",
	NASDAQ: "NASDAQ",
	"New York Stock Exchange": "NYSE",
	"NYSE American": "NYSE",
	"NYSE Arca": "NYSE",
	NYSE: "NYSE",
	"London Stock Exchange": "LSE",
	LSE: "LSE",
};

export function normalizeFmpExchange(raw: string): "NASDAQ" | "NYSE" | "LSE" | null {
	return EXCHANGE_NORMALIZATION[raw] ?? null;
}

interface ExchangeResolverDeps {
	fetch?: (path: string, params: Record<string, string>) => Promise<unknown>;
}

const exchangeCache = new Map<string, { exchange: "NASDAQ" | "NYSE" | "LSE" | null; expiresAt: number }>();
const EXCHANGE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function _resetExchangeResolverCache(): void {
	exchangeCache.clear();
}

export async function fmpResolveExchange(
	symbol: string,
	deps: ExchangeResolverDeps = {},
): Promise<"NASDAQ" | "NYSE" | "LSE" | null> {
	const now = Date.now();
	const cached = exchangeCache.get(symbol);
	if (cached && cached.expiresAt > now) return cached.exchange;

	const fetcher =
		deps.fetch ??
		((path, params) =>
			fmpFetch<Array<{ symbol: string; exchange: string; isActivelyTrading?: boolean }>>(
				path,
				params,
			));

	try {
		const data = (await fetcher("/profile", { symbol })) as Array<{
			symbol: string;
			exchange: string;
			isActivelyTrading?: boolean;
		}>;
		if (!data || data.length === 0) {
			exchangeCache.set(symbol, { exchange: null, expiresAt: now + EXCHANGE_TTL_MS });
			return null;
		}
		const normalized = normalizeFmpExchange(data[0]!.exchange);
		exchangeCache.set(symbol, { exchange: normalized, expiresAt: now + EXCHANGE_TTL_MS });
		return normalized;
	} catch {
		exchangeCache.set(symbol, { exchange: null, expiresAt: now + EXCHANGE_TTL_MS });
		return null;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/data/fmp-resolve-exchange.test.ts`
Expected: 9 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/data/fmp.ts tests/data/fmp-resolve-exchange.test.ts
git commit -m "Add fmpResolveExchange backed by /profile + 24h cache"
```

---

### Task 2: Universe spec parser (`exchange-resolver.ts`)

**Files:**
- Create: `src/news/exchange-resolver.ts`
- Test: `tests/news/exchange-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/news/exchange-resolver.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _resetExchangeResolverCache } from "../../src/data/fmp.ts";
import { parseUniverseSpec } from "../../src/news/exchange-resolver.ts";

describe("parseUniverseSpec", () => {
	beforeEach(() => {
		_resetExchangeResolverCache();
	});

	test("explicit exchange suffix wins (no FMP call)", async () => {
		const resolver = mock(async () => "NASDAQ" as const);
		const result = await parseUniverseSpec("SHEL:LSE", { resolver });
		expect(result).toEqual({ symbol: "SHEL", exchange: "LSE" });
		expect(resolver).not.toHaveBeenCalled();
	});

	test("bare symbol resolved via FMP", async () => {
		const resolver = mock(async () => "NYSE" as const);
		const result = await parseUniverseSpec("JPM", { resolver });
		expect(result).toEqual({ symbol: "JPM", exchange: "NYSE" });
		expect(resolver).toHaveBeenCalledWith("JPM");
	});

	test("returns null when resolver cannot determine exchange", async () => {
		const resolver = mock(async () => null);
		const result = await parseUniverseSpec("FAKE", { resolver });
		expect(result).toBeNull();
	});

	test("malformed spec returns null", async () => {
		const resolver = mock(async () => "NYSE" as const);
		expect(await parseUniverseSpec("", { resolver })).toBeNull();
		expect(await parseUniverseSpec(":NYSE", { resolver })).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/news/exchange-resolver.test.ts`
Expected: FAIL with import error.

- [ ] **Step 3: Implement the resolver**

```ts
// src/news/exchange-resolver.ts
import type { Exchange } from "../broker/contracts.ts";
import { fmpResolveExchange } from "../data/fmp.ts";

export interface ParseDeps {
	resolver?: (symbol: string) => Promise<Exchange | null>;
}

export async function parseUniverseSpec(
	spec: string,
	deps: ParseDeps = {},
): Promise<{ symbol: string; exchange: Exchange } | null> {
	if (!spec) return null;
	if (spec.includes(":")) {
		const [sym, ex] = spec.split(":");
		if (!sym || !ex) return null;
		return { symbol: sym, exchange: ex as Exchange };
	}
	const resolver = deps.resolver ?? ((s: string) => fmpResolveExchange(s));
	const exchange = await resolver(spec);
	if (!exchange) return null;
	return { symbol: spec, exchange };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/news/exchange-resolver.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/news/exchange-resolver.ts tests/news/exchange-resolver.test.ts
git commit -m "Add parseUniverseSpec resolving bare symbols via FMP"
```

---

### Task 3: Replace NASDAQ default in `buildUniverseWhitelist`

**Files:**
- Modify: `src/news/research-agent.ts:186-215`
- Modify: `tests/news/research-agent.test.ts` *(if existing whitelist tests assert NASDAQ for bare symbols)*

- [ ] **Step 1: Inspect existing tests**

Run: `grep -n "buildUniverseWhitelist\|NASDAQ" tests/news/research-agent.test.ts`
Note any assertion that depends on the bare-symbol-default behavior. Update those to seed strategies with explicit `:EXCHANGE` suffixes OR to inject a stub resolver.

- [ ] **Step 2: Write a new failing test**

Add to `tests/news/research-agent.test.ts`:

```ts
test("buildUniverseWhitelist resolves bare US symbols via FMP", async () => {
	// Seed a paper strategy with bare JPM (real-world: NYSE)
	const db = getDb();
	await db.insert(strategies).values({
		name: "test_jpm",
		description: "t",
		parameters: "{}",
		signals: "{}",
		universe: JSON.stringify(["AAPL", "JPM", "SHEL:LSE"]),
		status: "paper",
		virtualBalance: 10000,
		generation: 1,
		createdAt: new Date().toISOString(),
	});

	// Stub the FMP profile fetcher
	_resetExchangeResolverCache();
	mockFetch.mockImplementation((path: string, params: { symbol: string }) => {
		if (path === "/profile" && params.symbol === "AAPL")
			return Promise.resolve([{ symbol: "AAPL", exchange: "NASDAQ Global Select" }]);
		if (path === "/profile" && params.symbol === "JPM")
			return Promise.resolve([{ symbol: "JPM", exchange: "New York Stock Exchange" }]);
		return Promise.resolve([]);
	});

	const wl = await buildUniverseWhitelist();
	expect(wl).toContainEqual({ symbol: "AAPL", exchange: "NASDAQ" });
	expect(wl).toContainEqual({ symbol: "JPM", exchange: "NYSE" });
	expect(wl).toContainEqual({ symbol: "SHEL", exchange: "LSE" });
});
```

(Adapt `mockFetch` to whatever DI hook exists in research-agent tests; if none, expose a `deps` parameter on `buildUniverseWhitelist` mirroring Task 1.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/news/research-agent.test.ts`
Expected: FAIL — current code returns `JPM/NASDAQ`.

- [ ] **Step 4: Update `buildUniverseWhitelist`**

In `src/news/research-agent.ts`, replace lines 205-212:

```ts
		for (const spec of list) {
			const parsed = await parseUniverseSpec(spec);
			if (!parsed) {
				log.warn({ spec }, "buildUniverseWhitelist: could not resolve exchange — skipped");
				continue;
			}
			const key = `${parsed.symbol}:${parsed.exchange}`;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(parsed);
		}
```

Add the import at the top of the file:

```ts
import { parseUniverseSpec } from "./exchange-resolver.ts";
```

- [ ] **Step 5: Run all news tests**

Run: `bun test --preload ./tests/preload.ts tests/news/`
Expected: all pass. Update any assertion that broke because of the changed default — bias toward seeding strategies with explicit `:EXCHANGE` suffixes in test fixtures.

- [ ] **Step 6: Commit**

```bash
git add src/news/research-agent.ts tests/news/research-agent.test.ts
git commit -m "Resolve canonical exchange in buildUniverseWhitelist"
```

---

### Task 4: Replace NASDAQ default in `filterUniverseByExchanges`

**Files:**
- Modify: `src/scheduler/strategy-eval-job.ts:16-24`
- Modify: `tests/scheduler/strategy-eval-job.test.ts` *(any test asserting bare-symbol default behavior)*

- [ ] **Step 1: Inspect existing tests**

Run: `grep -n "filterUniverseByExchanges\|NASDAQ" tests/scheduler/strategy-eval-job.test.ts`

- [ ] **Step 2: Write a failing test**

```ts
test("filterUniverseByExchanges resolves bare symbols via FMP", async () => {
	_resetExchangeResolverCache();
	mockFetch.mockImplementation((path, params) => {
		if (path === "/profile" && params.symbol === "JPM")
			return Promise.resolve([{ symbol: "JPM", exchange: "New York Stock Exchange" }]);
		if (path === "/profile" && params.symbol === "AAPL")
			return Promise.resolve([{ symbol: "AAPL", exchange: "NASDAQ Global Select" }]);
		return Promise.resolve([]);
	});

	const result = await filterUniverseByExchanges(["JPM", "AAPL", "SHEL:LSE"], ["NYSE"]);
	expect(result).toEqual(["JPM"]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/scheduler/strategy-eval-job.test.ts`
Expected: FAIL — current code defaults JPM to NASDAQ and excludes it.

- [ ] **Step 4: Make `filterUniverseByExchanges` async + use resolver**

Replace lines 16-24 of `src/scheduler/strategy-eval-job.ts`:

```ts
import { parseUniverseSpec } from "../news/exchange-resolver.ts";

export async function filterUniverseByExchanges(
	universe: string[],
	exchanges?: Exchange[],
): Promise<string[]> {
	if (!exchanges || exchanges.length === 0) return universe;
	const exchangeSet = new Set(exchanges);
	const kept: string[] = [];
	for (const spec of universe) {
		const parsed = await parseUniverseSpec(spec);
		if (parsed && exchangeSet.has(parsed.exchange)) kept.push(spec);
	}
	return kept;
}
```

- [ ] **Step 5: Update callers**

Run: `grep -rn "filterUniverseByExchanges" src/ tests/`
Each caller must `await` the call. Common locations: `src/strategy/evaluator.ts`, `src/scheduler/strategy-eval-job.ts`. Update return-type expectations accordingly.

- [ ] **Step 6: Run full test suite**

Run: `bun test --preload ./tests/preload.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/strategy-eval-job.ts tests/scheduler/strategy-eval-job.test.ts src/strategy/evaluator.ts
git commit -m "Resolve canonical exchange in filterUniverseByExchanges"
```

---

### Task 5: One-shot data migration

**Files:**
- Create: `scripts/migrate-canonical-exchange.ts`

- [ ] **Step 1: Write the migration script**

```ts
// scripts/migrate-canonical-exchange.ts
// Idempotent. Re-resolves canonical exchange for every distinct symbol in
// news_analyses + quotes_cache and rewrites rows where the stored exchange
// disagrees with FMP /profile. Handles unique-index collisions via merge.

import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client.ts";
import { fmpResolveExchange } from "../src/data/fmp.ts";

async function main(): Promise<void> {
	const db = getDb();

	const symbolsRows = await db.all<{ symbol: string }>(
		sql`SELECT DISTINCT symbol FROM news_analyses`,
	);
	const symbols = symbolsRows.map((r) => r.symbol);
	console.log(`Resolving canonical exchange for ${symbols.length} symbols...`);

	const canonical = new Map<string, string>();
	for (const sym of symbols) {
		const ex = await fmpResolveExchange(sym);
		if (ex) {
			canonical.set(sym, ex);
		} else {
			console.warn(`SKIP: could not resolve exchange for ${sym}`);
		}
	}

	let analysesUpdated = 0;
	let analysesSkipped = 0;
	for (const [symbol, exchange] of canonical) {
		// Find rows whose exchange differs from canonical
		const rows = await db.all<{ id: number; exchange: string; news_event_id: number }>(
			sql`SELECT id, exchange, news_event_id FROM news_analyses
			    WHERE symbol = ${symbol} AND exchange != ${exchange}`,
		);
		for (const row of rows) {
			// Check if a canonical-exchange row already exists for this event+symbol
			const collision = await db.all<{ id: number }>(
				sql`SELECT id FROM news_analyses
				    WHERE news_event_id = ${row.news_event_id}
				      AND symbol = ${symbol}
				      AND exchange = ${exchange}`,
			);
			if (collision.length > 0) {
				// Drop the off-canonical duplicate; canonical row is the survivor.
				await db.run(sql`DELETE FROM news_analyses WHERE id = ${row.id}`);
				analysesSkipped++;
			} else {
				await db.run(
					sql`UPDATE news_analyses SET exchange = ${exchange} WHERE id = ${row.id}`,
				);
				analysesUpdated++;
			}
		}
	}

	let quotesUpdated = 0;
	let quotesDeleted = 0;
	for (const [symbol, exchange] of canonical) {
		const rows = await db.all<{ id: number; exchange: string }>(
			sql`SELECT id, exchange FROM quotes_cache
			    WHERE symbol = ${symbol} AND exchange != ${exchange}`,
		);
		for (const row of rows) {
			const collision = await db.all<{ id: number }>(
				sql`SELECT id FROM quotes_cache
				    WHERE symbol = ${symbol} AND exchange = ${exchange}`,
			);
			if (collision.length > 0) {
				await db.run(sql`DELETE FROM quotes_cache WHERE id = ${row.id}`);
				quotesDeleted++;
			} else {
				await db.run(
					sql`UPDATE quotes_cache SET exchange = ${exchange} WHERE id = ${row.id}`,
				);
				quotesUpdated++;
			}
		}
	}

	console.log(JSON.stringify({
		analysesUpdated,
		analysesSkipped,
		quotesUpdated,
		quotesDeleted,
	}, null, 2));

	closeDb();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: Dry-run locally against a copy of the prod DB**

```bash
scp -i ~/.ssh/trader-v2-deploy deploy@178.104.119.25:/opt/trader-v2/data/trader.db /tmp/trader-prod-copy.db
DB_PATH=/tmp/trader-prod-copy.db bun run scripts/migrate-canonical-exchange.ts
```

Expected output (approximate, based on today's snapshot):
```json
{
  "analysesUpdated": ~50,
  "analysesSkipped": 0,
  "quotesUpdated": ~3,
  "quotesDeleted": ~3
}
```

Spot-check:
```bash
sqlite3 /tmp/trader-prod-copy.db "SELECT exchange, COUNT(*) FROM news_analyses WHERE symbol='JPM' GROUP BY exchange;"
```
Expected: a single row, `NYSE`.

- [ ] **Step 3: Commit the script**

```bash
git add scripts/migrate-canonical-exchange.ts
git commit -m "Add canonical-exchange migration script"
```

- [ ] **Step 4: Push, deploy, then run on VPS**

```bash
git push origin main
# wait for GH Actions to deploy
ssh -i ~/.ssh/trader-v2-deploy deploy@178.104.119.25 \
  "cd /opt/trader-v2 && /home/deploy/.bun/bin/bun run scripts/migrate-canonical-exchange.ts"
```

Capture and verify the JSON summary matches the dry-run order of magnitude.

---

### Task 6: Verification

- [ ] **Step 1: Confirm no symbol is multi-tagged**

```bash
ssh -i ~/.ssh/trader-v2-deploy deploy@178.104.119.25 \
  "sqlite3 /opt/trader-v2/data/trader.db \"SELECT symbol, COUNT(DISTINCT exchange) n FROM news_analyses GROUP BY symbol HAVING n > 1;\""
```
Expected: empty result.

- [ ] **Step 2: Confirm a previously broken symbol now aggregates**

```bash
ssh -i ~/.ssh/trader-v2-deploy deploy@178.104.119.25 \
  "cd /opt/trader-v2 && /home/deploy/.bun/bin/bun -e \"
    import { getAggregatedNewsSignal } from './src/news/signal-aggregator.ts';
    const r = await getAggregatedNewsSignal('JPM','NYSE');
    console.log(JSON.stringify(r));
  \""
```
Expected: `sentiment` is non-null and matches the negative tilt seen in raw `news_analyses` rows.

- [ ] **Step 3: Tail the next strategy_eval_us run**

```bash
ssh -i ~/.ssh/trader-v2-deploy deploy@178.104.119.25 "sudo journalctl -u trader-v2 -n 200 --no-pager | grep -i 'strategy_eval_us\\|JPM\\|news_sentiment'"
```
Verify no warnings about unresolvable exchanges and no flood of "could not resolve" log lines.

---

## Self-Review Notes

- **Spec coverage:** root cause (NASDAQ default in 2 sites) → Tasks 3, 4. Orphaned data → Task 5. Resolver primitive → Tasks 1, 2. Verification → Task 6. ✅
- **Async ripple:** `filterUniverseByExchanges` becomes async (Task 4) — Step 5 explicitly catches all callers.
- **Idempotency:** migration script can be re-run safely; collision branch handles repeat runs.
- **Failure mode:** if FMP is down during whitelist build, `parseUniverseSpec` returns null → symbol skipped with a logged warning. The current behavior would silently default to NASDAQ. Skipping is the safer failure mode.
- **No placeholders.** All code blocks are concrete; bash commands are concrete.
