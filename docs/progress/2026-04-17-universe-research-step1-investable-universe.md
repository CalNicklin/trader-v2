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
- [ ] Task 6: Weekly refresh orchestrator
- [ ] Task 7: Daily delta check (halt/bankrupt detection)
- [ ] Task 8: Cron job registration (weekly + daily)
- [ ] Task 9: Health endpoint exposure
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
