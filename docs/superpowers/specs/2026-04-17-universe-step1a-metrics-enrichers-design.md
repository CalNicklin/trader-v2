# Universe Step 1a — Metrics Enrichers Design Spec

**Date:** 2026-04-17
**Status:** Approved, ready for implementation plan
**Motivation:** Universe Step 1 shipped infrastructure but rejects every candidate as `missing_data` because `marketCapUsd`, `freeFloatUsd`, and `listingAgeDays` are hard-coded to null in `metrics-enricher.ts`. Step 1a wires up real enrichers so the weekly refresh produces an actually populated investable universe.

**Parent:** `docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md`

## Goal

Make the Monday 03:00 UTC universe refresh produce a non-empty `investable_universe` table with the maximum viable symbol coverage, without adding paid data feeds or new integrations.

## Approach summary

Hybrid enrichment by exchange origin:

- **US names (Russell 1000)**: FMP `/v3/profile/<symbol>` batch endpoint provides `marketCapUsd`, `freeFloatUsd`, `listingAgeDays`
- **UK names (FTSE 350, AIM All-Share)**: no profile fetch. Rely on existing `quotes_cache` data populated by IBKR market-data snapshots (price, volume, spread)

Liquidity filter relaxes `freeFloatUsd` from a "required critical field" to an "optional if present" field — same treatment as `spreadBps` and `listingAgeDays` already get. Required critical fields reduce to just `price` and `avgDollarVolume`.

## Why not full dual-source

IBKR `reqFundamentalData` could cover UK fundamentals but (a) requires per-symbol XML requests, slow; (b) introduces new failure modes against IBKR's rate limits; (c) the `$5M ADV + price floor` filter is already a stronger liquidity signal than free-float for the AIM small-caps we actually care about. The free-float protection is cheap insurance we weren't using effectively. If we later want it for UK, we add it as an independent enricher without rewriting anything.

## New table `symbol_profiles`

```
id               integer PK
symbol           text
exchange         text
market_cap_usd   real (nullable)
shares_outstanding  real (nullable)
free_float_shares   real (nullable)
ipo_date         text (nullable, ISO date)
fetched_at       text NOT NULL, default now-ISO
UNIQUE (symbol, exchange)
```

Acts as last-known-good cache. Rows refreshed on demand during universe refresh; never deleted (historical profile data is useful for backtests).

## New module `src/universe/profile-fetcher.ts`

Exports:

- `SymbolProfile` interface: `{symbol, exchange, marketCapUsd, sharesOutstanding, freeFloatShares, ipoDate, fetchedAt}`
- `fetchSymbolProfiles(symbols: string[], fetchImpl?): Promise<SymbolProfile[]>` — batched FMP calls, 500 symbols per batch
- `upsertProfiles(profiles: SymbolProfile[]): Promise<void>` — writes to `symbol_profiles`
- `getProfile(symbol: string, exchange: string): Promise<SymbolProfile | null>` — reads cached
- `PROFILE_CACHE_TTL_DAYS = 30` — profiles older than this are treated as stale

FMP endpoint: `GET https://financialmodelingprep.com/api/v3/profile/<comma-separated-symbols>?apikey=...`. Response is an array of objects per symbol with fields including `mktCap`, `sharesOutstanding`, `floatShares` (sometimes null), `ipoDate`.

## Modified `src/universe/metrics-enricher.ts`

Before enriching candidates, split them by exchange:

- **US candidates**: look up `symbol_profiles` cache. If present and fresh (≤30d), use it. If missing or stale, batch-fetch via `fetchSymbolProfiles`. If fetch succeeds, upsert and use fresh. If fetch fails AND we have any cached row (any age), use the cached row (last-known-good). If fetch fails AND no cache, leave profile fields null.
- **UK candidates**: skip profile fetch entirely. Profile fields stay null.

All candidates then get `price`, `avgDollarVolume`, `spreadBps` from `quotes_cache` as before.

Derived fields on the `FilterCandidate`:

- `marketCapUsd` ← `mktCap` from FMP profile (US only), else null
- `freeFloatUsd` ← `floatShares × price` if `floatShares` is present; else `sharesOutstanding × price` as overestimate fallback; else null. Calculated only for US.
- `listingAgeDays` ← `Math.floor((Date.now() - Date.parse(ipoDate)) / 86_400_000)` if `ipoDate` present (US only), else null

## Modified `src/universe/filters.ts`

**`freeFloatUsd` is no longer a critical missing-data field.** Rationale: we now know UK candidates will systematically lack it. Treating it as critical means every UK candidate always rejects — defeats the purpose.

Change:

- Before: `if (c.avgDollarVolume == null || c.price == null || c.freeFloatUsd == null) reasons.push("missing_data")`
- After: `if (c.avgDollarVolume == null || c.price == null) reasons.push("missing_data")`
- `freeFloatUsd` still gets a `low_float` check only when present AND below threshold (identical treatment to `spreadBps` and `listingAgeDays` today)

Existing tests in `tests/universe/filters.test.ts` need updating — the "missing_data" test that currently sets `avgDollarVolume: null, price: null` is fine (still rejects). But no existing test relies on freeFloatUsd alone triggering missing_data. Add a new test: UK-shaped candidate (exchange LSE, freeFloatUsd null, all other critical fields present) PASSES.

## Cron wiring

No new cron jobs. The weekly refresh already calls `fetchCandidatesFromAllSources` → `enrichWithMetrics`. The profile fetch happens inside `enrichWithMetrics` on demand.

On-demand fetch pattern:

1. Collect US symbols from candidates
2. Query `symbol_profiles` for those symbols
3. Determine which symbols need refresh (not cached, or cached > 30 days ago)
4. Batch-fetch those symbols from FMP (500 per batch)
5. Upsert results
6. Merge cached + freshly-fetched profiles, apply to candidates

Total FMP calls per weekly refresh: `ceil(stale_us_symbols / 500)`. On cold start that's `ceil(~700 / 500) = 2` calls. Subsequent weeks refetch only symbols whose cache has aged out — much smaller.

## Error handling

Per Cal's C decision (last-known-good):

- FMP batch call fails entirely → log warning, use whatever is in `symbol_profiles` regardless of age. Proceed with refresh.
- FMP returns response but some symbols missing from the result → those symbols use cached data if available (any age), else null.
- Cached profile older than 30 days AND fresh fetch unavailable → still use the cached data rather than rejecting the symbol. Log this at info level so it's visible in ops.

## Field-level fallback logic for free-float

FMP's `floatShares` field is unreliable across the Russell 1000 — often null for less liquid names. Priority order:

1. If `floatShares != null`: `freeFloatUsd = floatShares × price`
2. Else if `sharesOutstanding != null`: `freeFloatUsd = sharesOutstanding × price` — this is a market-cap estimate, strictly an overestimate of free float. Acceptable because (a) it's strictly more forgiving, not less, so we don't falsely reject good names, (b) the filter threshold $100M is loose enough that the difference rarely matters.
3. Else: null

Document this explicitly in code because future readers will wonder why we use shares-outstanding for "free float".

## Non-goals (deferred)

- UK fundamentals via IBKR `reqFundamentalData` — if we ever want free-float protection for UK names, add it as an independent enricher.
- Intraday profile updates — fundamentals don't change within a week.
- Per-symbol TTL overrides — flat 30 days.
- Alternative data sources on FMP outage — the last-known-good fallback handles transient failures; a sustained FMP outage would eventually stale out the cache, but that's an operational issue not a design one.
- Re-running seed script after this ships — Cal will trigger manually on VPS post-deploy.

## Success criteria

After Step 1a merges and the Monday refresh runs:

1. `investable_universe` has 600–900 active rows (Russell 1000 post-liquidity-filter + FTSE 350 post-liquidity-filter + AIM post-liquidity-filter)
2. `symbol_profiles` has roughly 700 US rows (one per Russell 1000 symbol that returned a valid FMP profile)
3. `/health` universe section shows non-zero counts for all three `bySource` buckets
4. No regressions: 729 tests still pass, typecheck and lint clean
5. One weekly refresh completes end-to-end without errors (verified via logs post-deploy)
