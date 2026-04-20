# Progress — Catalyst-Triggered Dispatch

**Plan:** `docs/superpowers/plans/2026-04-20-catalyst-triggered-dispatch.md`
**Spec:** `docs/superpowers/specs/2026-04-20-catalyst-triggered-dispatch-design.md`
**Branch:** `feat/catalyst-triggered-dispatch`

## Baseline (pre-implementation)
- Branch: `feat/catalyst-triggered-dispatch`
- `bun run typecheck`: pass
- `bun test --preload ./tests/preload.ts`: 817 pass / 0 fail
- Last commit: `4b15306 docs: implementation plan for catalyst-triggered dispatch`

## Task status
| # | Task | Status | SHA |
|---|------|--------|-----|
| 0 | Prep / baseline verification | completed | — (no changes) |
| 1 | Add `dispatch_decisions` schema + migration | completed | 08005cf |
| 2 | dispatch-store: read path + precedence | completed | 5cb4e10 |
| 3 | dispatch-store: write + expire paths | completed | 1ae6e60 |
| 4 | Wire scheduled `runDispatch` to dispatch-store | completed | 60e3d15 |
| 5 | Switch evaluator to `getActiveDecisions` | completed | 60e3d15 (same) |
| 6 | Nightly cleanup job | completed | 37297db |
| 7 | Add `CATALYST_DISPATCH_ENABLED` config | completed | 8c7899e |
| 8 | Catalyst prompt builder | completed | 9c6596c |
| 9 | Catalyst dispatcher: rate-limit state machine | completed | 16a0c73 |
| 10 | Catalyst dispatcher: debounce + Haiku + DB write + evaluator kick | completed | a86dab1 |
| 11 | Wire catalyst dispatch into news ingest | completed | 8de8cc7 |
| 12 | Health / monitoring exposure | completed | 043b60f |
| 13 | Eval suite for catalyst dispatch | completed | fce68c2 |
| 14 | Deploy-disabled verification + PR | pending | |

(Task 15 is a manual post-merge rollout step — not executed by the agent.)

---

## Todo: 0
Status: completed
Layer: L0

Completed work
- Verified branch `feat/catalyst-triggered-dispatch`.
- Ran `bun run typecheck`: pass.
- Ran `bun test --preload ./tests/preload.ts`: 817/817 pass.

Exported contracts and types
- None.

Verification
- typecheck: pass
- tests: pass (817/817)
- format/lint: not run (nothing changed)

Commit
- none (baseline verification only)

Next todo
- 1 — Add `dispatch_decisions` schema + migration.

Decisions / deferrals
- None.

---

## Todo: 1
Status: completed
Layer: L1

Completed work
- Added `dispatchDecisions` Drizzle table to `src/db/schema.ts` with columns `id, strategy_id, symbol, action, reasoning, source, source_news_event_id, created_at, expires_at`, and indexes on `(expires_at, action)` and `(strategy_id, symbol)`.
- Wrote migration `drizzle/migrations/0018_dispatch_decisions.sql` by hand — `drizzle-kit generate` requires TTY to resolve a stale `symbol_profiles` table conflict in `0017_snapshot.json`.
- Appended idx=18 entry to `drizzle/migrations/meta/_journal.json`.
- Verified migration applies to a fresh DB and the table + both indexes are created as expected.

Exported contracts and types
- `dispatchDecisions` Drizzle table (schema.ts) — importable via `import { dispatchDecisions } from './db/schema.ts'`.

Verification
- typecheck: pass
- tests: 817/817 pass (no new tests in this task)
- biome: pass
- db:migrate on fresh DB: applies cleanly through 0018
- SQL inspection: CREATE TABLE + 2 indexes confirmed

Commit
- 08005cf feat(db): add dispatch_decisions table for catalyst-triggered dispatch

Next todo
- 2 — dispatch-store read path + precedence.

Decisions / deferrals
- Skipped generating `0018_snapshot.json` — matches existing pattern where 0012 and 0013 snapshots are also absent. Future drizzle-kit runs will still face the pre-existing `symbol_profiles` prompt; out of scope here.

---

## Todo: 2
Status: completed
Layer: L1

Completed work
- Implemented `getActiveDecisions` in `src/strategy/dispatch-store.ts`. Uses SQLite `ROW_NUMBER() OVER (PARTITION BY strategy_id, symbol)` with catalyst-before-scheduled + newest-first tiebreak. Expiry comparison uses a JS-generated ISO timestamp parameter instead of SQLite `datetime('now')`.
- 6 tests cover: empty table, non-expired scheduled row, expired filtered out, catalyst-beats-scheduled, newest-catalyst-wins, multiple distinct pairs.

Exported contracts and types
- `DispatchDecisionRow` interface — `{ id, strategyId, symbol, action, reasoning, source, sourceNewsEventId, createdAt, expiresAt }`.
- `getActiveDecisions(): Promise<DispatchDecisionRow[]>`.

Verification
- typecheck: pass
- tests: 823/823 pass (6 new)
- biome: pass

Commit
- 5cb4e10 feat(dispatch): dispatch-store getActiveDecisions with precedence

Next todo
- 3 — dispatch-store write + expire + cleanup.

Decisions / deferrals
- SQLite `datetime('now')` returns `YYYY-MM-DD HH:MM:SS` — our stored ISO strings (`...T...Z`) sort higher lexicographically because `T` (0x54) > space (0x20). Passing an ISO parameter from JS avoids the class of bug; worth keeping in mind for later write/expire paths.

---

## Todo: 3
Status: completed
Layer: L1

Completed work
- Added `DispatchDecisionInput` interface and four write/mutate functions to `src/strategy/dispatch-store.ts`:
  - `writeScheduledDecisions(decisions, expiresAt)` — inserts with source='scheduled'.
  - `writeCatalystDecisions(decisions, expiresAt, newsEventId)` — inserts with source='catalyst'.
  - `expireScheduledDecisions()` — sets expiresAt=now on all active scheduled rows; catalyst rows untouched.
  - `cleanupExpiredDecisions()` — deletes rows older than 24h past expiry, returns count.
- Used Drizzle query builder (not raw `db.run()`) because `db.run` returns `void` under bun:sqlite's Drizzle driver — no access to `.changes`. Cleanup pre-selects doomed ids to report the count.
- 5 new tests cover each path including empty-array no-op.

Exported contracts and types
- `DispatchDecisionInput` — `{ strategyId, symbol, action, reasoning }`.
- `writeScheduledDecisions`, `writeCatalystDecisions`, `expireScheduledDecisions`, `cleanupExpiredDecisions`.

Verification
- typecheck: pass
- tests: 828/828 pass (5 new)
- biome: pass

Commit
- 1ae6e60 feat(dispatch): dispatch-store write/expire/cleanup

Next todo
- 4 — wire scheduled runDispatch to dispatch-store.

Decisions / deferrals
- None.

---

## Todos: 4 + 5 (shipped together)
Status: completed
Layer: L2

Completed work
- Rewrote `src/strategy/dispatch.ts`:
  - Removed `latestDecisions`, `getLatestDispatchDecisions`, `clearDispatchDecisions`.
  - `DispatchDecision` now extends `DispatchDecisionInput` (shared shape).
  - `runDispatch` calls `expireScheduledDecisions()` then `writeScheduledDecisions(decisions, now+6h)` after parsing the Haiku response.
  - `parseDispatchResponse` hardened: `typeof d.strategyId !== "number"` check to avoid falsy-zero false negatives.
- Edited `src/strategy/evaluator.ts`:
  - Import swapped to `getActiveDecisions` from `./dispatch-store.ts`.
  - `getLatestDispatchDecisions()` → `await getActiveDecisions()`.
  - Removed both `clearDispatchDecisions()` calls — decisions expire by TTL, not by eval-tick clearing.
- T4 and T5 ship atomically because T4 alone left evaluator referencing removed exports.

Exported contracts and types
- `DispatchDecision` now `extends DispatchDecisionInput` — same field shape as `DispatchDecisionRow`.

Verification
- typecheck: pass
- tests: 828/828 pass
- biome: pass (format autofix applied)

Commit
- 60e3d15 feat(dispatch): runDispatch + evaluator use dispatch_decisions table

Next todo
- 6 — nightly dispatch_decisions cleanup job.

Decisions / deferrals
- Ships T4 and T5 in one commit rather than two because no intermediate state is buildable.

---

## Todo: 6
Status: completed
Layer: L2

Completed work
- Added `dispatch_decisions_cleanup` to `JobName`, `JOB_LOCK_CATEGORY` (`maintenance`), and `executeJob` switch in `src/scheduler/jobs.ts`.
- Scheduled at 22:20 Europe/London Mon–Fri in `src/scheduler/cron.ts` (between existing trade_review 22:15 and missed_opportunity_daily 22:25).
- Mirrored in `src/monitoring/cron-schedule.ts`.
- Updated cron-count assertions in `tests/monitoring/cron-schedule.test.ts` and `tests/monitoring/dashboard-data.test.ts` from 41 → 42.

Exported contracts and types
- `JobName` union now includes `"dispatch_decisions_cleanup"`.

Verification
- typecheck: pass
- tests: 828/828 pass
- biome: pass

Commit
- 37297db feat(scheduler): nightly dispatch_decisions cleanup job

Next todo
- 7 — CATALYST_DISPATCH_ENABLED config flag.

Decisions / deferrals
- Plan spec'd 22:30 but that slot is occupied by universe_delta_daily; moved to 22:20 (empty minute adjacent to other analysis jobs).
