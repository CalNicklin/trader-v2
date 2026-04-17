# Universe Research Step 1 — Progress

Plan: docs/superpowers/plans/2026-04-17-universe-research-step1-investable-universe.md
Spec: docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md
Branch: feat/universe-step1-investable-universe
Baseline at start: 702 tests pass, 0 fail, typecheck clean.

## Task status

- [x] Task 1: Schema — investable_universe + universe_snapshots tables
- [x] Task 2: FMP Russell 1000 constituents fetcher
- [x] Task 3: FMP FTSE 350 + AIM constituents fetchers
- [x] Task 4: Liquidity filter pipeline
- [x] Task 5: Universe snapshot writer
- [x] Task 6: Weekly refresh orchestrator
- [x] Task 7: Daily delta check (halt/bankrupt detection)
- [x] Task 8: Cron job registration (weekly + daily)
- [x] Task 9: Health endpoint exposure
- [ ] Task 10: Initial seed + verification
- [ ] Task 11: End-to-end integration test

## Completed tasks

(will be appended below as tasks complete)

## Task 1: completed

**Layer:** L0 (schema foundation)

**Completed work:**
- Added `investable_universe` table definition to `src/db/schema.ts`
- Added `universe_snapshots` table definition to `src/db/schema.ts`
- Generated migration file: `drizzle/migrations/0014_old_the_initiative.sql`
- Verified migration applies cleanly against a fresh DB

**Exported contracts and types:**
- `investableUniverse` (table schema)
- `universeSnapshots` (table schema)
- `InferInsertModel<typeof investableUniverse>` (implicit)
- `InferSelectModel<typeof universeSnapshots>` (implicit)

**Verification:**
- typecheck: pass
- tests: 702/702 pass
- lint: clean (2 pre-existing warnings in test stubs only)

**Commit:** 37a7bf0 — Universe Step 1 Task 1: investable_universe + universe_snapshots schema

**Next task:** Task 2 — FMP Russell 1000 constituents fetcher

## Task 2: completed

**Layer:** L1 (data layer)

**Completed work:**
- Created `src/universe/sources.ts` with `fetchRussell1000Constituents`
- Created `tests/universe/sources.test.ts` with 3 tests

**Exported contracts:**
- `ConstituentRow` (interface: symbol, exchange, indexSource)
- `fetchRussell1000Constituents(fetchImpl?): Promise<ConstituentRow[]>`

**Verification:**
- typecheck: pass
- tests: 705/705 pass
- lint: clean

**Commit:** 7fe32c0 — Universe Step 1 Task 2: Russell 1000 constituents fetcher

**Next task:** Task 3 — FTSE 350 + AIM constituents fetchers

## Task 3: completed

**Layer:** L1 (data layer)

**Completed work:**
- Extended `src/universe/sources.ts` with `fetchFtse350Constituents` and `fetchAimAllShareConstituents`
- Added symbol-normalisation helper `normaliseLondonSymbol` (strips `.L` suffix)
- Added 2 tests to `tests/universe/sources.test.ts`

**Exported contracts:**
- `fetchFtse350Constituents(fetchImpl?): Promise<ConstituentRow[]>`
- `fetchAimAllShareConstituents(fetchImpl?): Promise<ConstituentRow[]>`

**Verification:**
- typecheck: pass
- tests: 707/707 pass
- lint: clean

**Commit:** 2cdabac — Universe Step 1 Task 3: FTSE 350 + AIM constituents fetchers

**Next task:** Task 4 — Liquidity filter pipeline

## Task 4: completed

**Layer:** L1 (data layer)

**Completed work:**
- Created `src/universe/constants.ts` with 7 liquidity thresholds
- Created `src/universe/filters.ts` with `applyLiquidityFilters`
- Created `tests/universe/filters.test.ts` with 10 tests covering all rejection paths

**Exported contracts:**
- `MIN_AVG_DOLLAR_VOLUME_USD`, `MIN_PRICE_USD`, `MIN_PRICE_GBP_PENCE`, `MIN_FREE_FLOAT_USD`, `MAX_SPREAD_BPS`, `MIN_LISTING_AGE_DAYS`, `MAX_UNIVERSE_SIZE` (constants)
- `FilterCandidate` (interface extending ConstituentRow with nullable metrics)
- `RejectionReason` (union of 6 reason strings)
- `FilterResult` (passed/rejected shape)
- `applyLiquidityFilters(candidates): FilterResult`

**Verification:**
- typecheck: pass
- tests: 717/717 pass
- lint: clean

**Commit:** 34d8678 — Universe Step 1 Task 4: liquidity filter pipeline

**Next task:** Task 5 — Universe snapshot writer

## Task 5: completed

**Layer:** L2 (orchestration)

**Completed work:**
- Created `src/universe/snapshots.ts` with `writeDailySnapshot`
- Created `tests/universe/snapshots.test.ts` with 3 tests

**Exported contracts:**
- `SymbolRef` interface: `{ symbol, exchange }`
- `SnapshotInput` interface: `{ current, previous, removalReasons? }`
- `writeDailySnapshot(date, input): Promise<{ added, removed }>`

**Verification:**
- typecheck: pass
- tests: 720/720 pass
- lint: clean

**Commit:** 637f632 — Universe Step 1 Task 5: daily snapshot writer

**Next task:** Task 6 — Weekly refresh orchestrator

## Task 6: completed

**Layer:** L2 (orchestration)

**Completed work:**
- Created `src/universe/repo.ts` with `getActiveUniverseMembership`
- Created `src/universe/refresh.ts` with `refreshInvestableUniverse`
- Created `tests/universe/refresh.test.ts` with 3 tests

**Exported contracts:**
- `getActiveUniverseMembership(): Promise<SymbolRef[]>`
- `RefreshInput` interface
- `RefreshResult` interface: `{ added, removed, rejected }`
- `refreshInvestableUniverse(input): Promise<RefreshResult>`

**Verification:**
- typecheck: pass
- tests: 723/723 pass
- lint: clean (2 pre-existing warnings in unrelated test stubs)

**Commit:** ec4ab71 — Universe Step 1 Task 6: weekly refresh orchestrator

**Fix commit:** 50610a0 — Transaction-wrap refresh + capture now once (wraps upsert/deactivate/snapshot in db.transaction; single `now` timestamp for all writes)

**Next task:** Task 7 — Daily delta check

## Task 7: completed

**Layer:** L2 (orchestration)

**Completed work:**
- Created `src/universe/delta.ts` with `runDailyDeltaCheck`
- Created `tests/universe/delta.test.ts` with 3 tests

**Exported contracts:**
- `DeltaFlag` interface: `{ symbol, exchange, reason }`
- `DeltaCheckInput` interface: `{ checker, snapshotDate, exemptSymbols? }`
- `DeltaCheckResult` interface: `{ demoted }`
- `runDailyDeltaCheck(input): Promise<DeltaCheckResult>`

**Verification:**
- typecheck: pass
- tests: 726/726 pass
- lint: clean

**Commit:** 6139bc7

**Next task:** Task 8 — Cron wiring + source aggregator + metrics enricher + halt checker

## Task 8: completed

**Layer:** L3 (wiring)

**Completed work:**
- Added `getOpenPositionSymbols` to `src/paper/manager.ts` (not previously present)
- Created `src/universe/metrics-enricher.ts` with `enrichWithMetrics`
- Created `src/universe/source-aggregator.ts` with `fetchCandidatesFromAllSources`
- Created `src/universe/halt-checker.ts` with v1 no-op `ibkrHaltChecker`
- Created `src/scheduler/universe-jobs.ts` with `runWeeklyUniverseRefresh` and `runDailyUniverseDelta`
- Registered 2 new job names in `src/scheduler/jobs.ts` (`universe_refresh_weekly`, `universe_delta_daily`)
- Registered 2 new cron jobs in `src/scheduler/cron.ts` and mirrored in `src/monitoring/cron-schedule.ts`
- Updated test count assertions from 30 to 32 in monitoring tests

**Exported contracts:**
- `getOpenPositionSymbols(): Promise<{symbol, exchange}[]>`
- `enrichWithMetrics(rows): Promise<FilterCandidate[]>`
- `fetchCandidatesFromAllSources(): Promise<FilterCandidate[]>`
- `ibkrHaltChecker(): Promise<DeltaFlag[]>` (v1 no-op)
- `runWeeklyUniverseRefresh(): Promise<void>`
- `runDailyUniverseDelta(): Promise<void>`

**Verification:**
- typecheck: pass
- tests: 726/726 pass
- lint: clean

**Commit:** 378b7a0

**Next task:** Task 9 — Health endpoint exposure

## Task 9: completed

**Layer:** L3 (wiring)

**Completed work:**
- Added `getUniverseHealth` to `src/monitoring/health.ts`
- Wired `universe: await getUniverseHealth()` into the main health JSON response
- Added `universe` field to the `HealthData` interface
- Added 2 tests covering empty and populated states

**Exported contracts:**
- `getUniverseHealth(): Promise<{activeCount, lastRefreshed, bySource}>`

**Verification:**
- typecheck: pass
- tests: 728/728 pass
- lint: clean

**Commit:** 1dbb6a2

**Next task:** Task 10 — Initial seed + verification
