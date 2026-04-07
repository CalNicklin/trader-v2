# Resolution -- Round 1

## Responses

### 1. `MutationProposal` and `ValidatedMutation` types do not accept `"structural"`
- **Action:** FIXED
- **Reasoning:** The critic is correct. `MutationProposal.type` is `"parameter_tweak" | "new_variant"` and `ValidatedMutation.type` is the same union in `src/evolution/types.ts`. The plan's Step 3 has a comment saying "Add to MutationProposal type (or wherever the type is defined)" but this is not an actionable implementation step. Both types must be updated in `src/evolution/types.ts` before any code referencing `"structural"` will compile.
- **Changes:** Added explicit Step 3a to Task 1 that updates both `MutationProposal` and `ValidatedMutation` type definitions in `src/evolution/types.ts`. The step includes exact type changes with file path.

### 2. DB schema enum does not include `"structural"` mutation type
- **Action:** FIXED
- **Reasoning:** The critic is correct. The `strategyMutations` table has `mutationType: text("mutation_type", { enum: ["parameter_tweak", "new_variant", "code_change"] })`. The spawner casts `mutation.type as "parameter_tweak" | "new_variant" | "code_change"`, which will mask the TypeScript error but insert `"structural"` into a column whose Drizzle enum does not include it. Two options: (a) add `"structural"` to the DB enum, or (b) map `structural` to `"code_change"` since they're semantically similar. Option (a) is cleaner -- add `"structural"` to the enum and update the spawner's cast. This requires a schema change but since the Drizzle enum on text columns is TypeScript-only (SQLite text columns have no actual enum constraint), no migration is needed -- just updating the schema definition.
- **Changes:** Added Step 3b to Task 1 that updates the DB schema enum in `src/db/schema.ts` to include `"structural"`, and updates the type cast in `src/evolution/spawner.ts`.

### 3. `callClaude` does not exist anywhere in the codebase
- **Action:** FIXED
- **Reasoning:** The critic is correct. No `callClaude` function exists. The codebase uses `new Anthropic()` + `client.messages.create()` directly (see `src/evolution/index.ts`). The plan references it in Task 4 Step 6 (dispatch runner) and Task 6 Step 3 (eval harness). Both need to be rewritten to use the raw Anthropic SDK pattern with `withRetry` and `recordUsage`, matching the established codebase pattern.
- **Changes:** Rewrote dispatch runner in Task 4 Step 6 and eval harness in Task 6 Step 3 to use `new Anthropic()` + `client.messages.create()` with `withRetry` and `recordUsage`, following the pattern in `src/evolution/index.ts`.

### 4. `getPerformanceLandscape()` returns a `PerformanceLandscape` object, not an array
- **Action:** FIXED
- **Reasoning:** The critic is correct. `getPerformanceLandscape()` returns `{ strategies, activePaperCount, timestamp }`. The plan calls `graduated.filter(...)` which will crash. Should be `graduated.strategies.filter(...)`.
- **Changes:** Fixed in Task 4 Step 6 dispatch runner to use `landscape.strategies.filter(...)`.

### 5. `canAffordCall` signature mismatch in dispatch
- **Action:** FIXED
- **Reasoning:** The critic is correct. `canAffordCall(estimatedCost: number, db?: DbClient)` -- second param is optional DB client, not a string label. `canAffordCall(0.02, "dispatch")` is a type error.
- **Changes:** Fixed in Task 4 Step 6 to `canAffordCall(0.02)` (no second argument).

### 6. `db` import pattern wrong in dispatch runner
- **Action:** FIXED
- **Reasoning:** The critic is correct. The codebase uses `getDb()` from `"../db/client"`, not `{ db } from "../db"`. Every module follows this pattern.
- **Changes:** Fixed in Task 4 Step 6 to import `getDb` from `"../db/client"` and call `const db = getDb()`.

### 7. `log` import pattern wrong in dispatch and tournament additions
- **Action:** FIXED
- **Reasoning:** The critic is correct. The logger exports `createChildLogger`, not `log`. Every module creates `const log = createChildLogger({ module: "..." })`.
- **Changes:** Fixed in Task 2 Step 3 and Task 4 Step 3 (and Step 6) to use `createChildLogger`. Also fixed in Task 6 Step 3 (eval harness).

### 8. Daily tournament removes steps 1-3 from weekly evolution but breaks its return type contract
- **Action:** FIXED
- **Reasoning:** The critic is correct. `runEvolutionCycle()` returns `{ drawdownKills, tournaments, populationCulls, spawned }` and the caller in `evolution-job.ts` logs `result.drawdownKills.length`, `result.tournaments`, `result.populationCulls.length`. Removing those calls without updating the return values will break the caller. The fix is to keep the return type but set the removed fields to empty/zero values with a comment explaining they moved to the daily job.
- **Changes:** Updated Task 2 Step 6 to specify setting `drawdownKills: []`, `tournaments: 0`, `populationCulls: []` in the return value, and adding a comment to `evolution-job.ts` noting these are now handled by the daily tournament job.

### 9. Tournament `MIN_TRADES_FOR_TOURNAMENT` stays at 30 while graduation drops to 20
- **Action:** PUSHED_BACK
- **Reasoning:** The critic raises a valid interaction concern, but the conclusion is wrong. Tournaments and graduation serve different purposes. Graduation promotes a strategy to probation -- it's about the strategy's own quality. Tournaments compare a parent-child pair and retire the loser -- they need MORE data (30 each) because relative comparison is noisier than absolute threshold checking. A strategy graduating at 20 trades while its tournament is pending at <30 trades is fine: the graduated strategy continues trading on probation, and the tournament resolves later once both reach 30. If the child wins the tournament, the parent retires. If the parent wins, the child (now on probation) gets demoted. This is the intended flow -- graduation is an early signal, tournaments are a more rigorous comparison that takes longer. Aligning them would either reduce tournament reliability (lowering to 20) or slow graduation (keeping at 30, defeating the purpose of Task 5).

### 10. Dispatch layer has no integration with the evaluator
- **Action:** FIXED
- **Reasoning:** The critic is correct and this is the most important issue. The plan creates dispatch decisions but nothing reads them. The evaluator unconditionally evaluates all paper strategies on all symbols. Without wiring dispatch decisions into the evaluator, the dispatch layer is dead code. The plan's file list says "Modify: `src/strategy/evaluator.ts` -- respect dispatch decisions" but no step implements this.
- **Changes:** Added Task 4 Step 6b that modifies `evaluateAllStrategies()` to check for recent dispatch decisions and filter strategy-symbol pairs accordingly. Dispatch decisions are stored in a lightweight in-memory cache (module-level variable) set by `runDispatch()` and read by the evaluator. For paper strategies (which don't have dispatch), evaluation continues unchanged. For graduated strategies, only activated strategy-symbol pairs are evaluated.

### 11. Regime signals are never actually computed from real data
- **Action:** PARTIALLY_ADDRESSED
- **Reasoning:** The critic is correct that the regime signals are hardcoded to neutral values and never populated from real data. However, the critic's severity is overstated. This is a bootstrapping problem -- regime detection requires historical data that accumulates over time. The plan correctly builds the infrastructure (detection functions, context wiring, types) and marks the dispatch runner values as TODO. The fix is to document this as a known limitation and create a follow-up task, not to implement full historical data aggregation in this plan (which would be scope creep requiring historical quote storage that doesn't exist yet).
- **Changes:** Added a note in Task 4 Step 6 explicitly documenting the neutral defaults as a known limitation with a clear follow-up condition ("populate once 20+ days of ATR history are available in quotes_cache"). Added a brief "Known Limitations" section at the end of the plan.

### 12. Kill test assumes `checkDailyHalt` exists but it does not
- **Action:** FIXED
- **Reasoning:** The critic is correct. No `checkDailyHalt` function exists. The correct function is `isTradingHalted()` which returns `{ halted, requiresManualRestart, reason }`. The test must be rewritten to use `isTradingHalted()` and check the `.halted` property.
- **Changes:** Rewrote kill test in Task 7 Step 1 to import `isTradingHalted` from `"../../src/risk/guardian"` and assert on `result.halted === true`. Also fixed the setup to use `daily_halt_active` flag (which is what `isTradingHalted` reads) rather than `daily_pnl`.

### 13. Kill test uses synchronous `db` import and `.run()` calls
- **Action:** FIXED
- **Reasoning:** The critic is correct. The `{ db } from "../../src/db"` import does not exist. Must use `getDb()` from `"../../src/db/client"`.
- **Changes:** Rewrote kill test to use `getDb()` pattern with `await` on all Drizzle operations, matching the codebase convention.

### 14. Dispatch prompt references `StrategyPerformance` from `../evolution/analyzer` and accesses non-existent `description` field
- **Action:** FIXED
- **Reasoning:** The critic is correct on both points. (a) `StrategyPerformance` is defined in `src/evolution/types.ts` and the analyzer does not re-export it. The import should be from `"../evolution/types"`. (b) `StrategyPerformance` has no `description` field -- it has `name`, `status`, `generation`, `parameters`, `signals`, `universe`, `metrics`, etc. The `strategies` table has a `description` column but it's not surfaced through `StrategyPerformance`. The prompt accesses `s.description` which will be `undefined`.
- **Changes:** Fixed import to `"../evolution/types"`. Removed `s.description` from the prompt template and replaced with strategy name + signal descriptions, which are available on the type.

## Summary of Plan Changes

1. **Task 1:** Added Step 3a (update types in `types.ts`) and Step 3b (update DB schema enum and spawner cast)
2. **Task 2 Step 3:** Fixed logger import to use `createChildLogger`
3. **Task 2 Step 6:** Updated to set removed return fields to empty/zero values
4. **Task 4 Step 3:** Fixed logger import to use `createChildLogger`
5. **Task 4 Step 5:** Fixed `StrategyPerformance` import source and removed `s.description` access
6. **Task 4 Step 6:** Complete rewrite -- use Anthropic SDK directly, fix `getPerformanceLandscape()` usage, fix `canAffordCall` signature, fix `db` import, fix `log` import, add explicit known-limitation note for regime defaults
7. **Task 4:** Added Step 6b for evaluator integration (dispatch decisions actually consumed)
8. **Task 6 Step 3:** Rewrote eval harness to use Anthropic SDK instead of `callClaude`, fixed `log` import
9. **Task 7 Step 1:** Rewrote kill test to use `isTradingHalted()`, `getDb()`, and async patterns
10. Added "Known Limitations" section at end of plan

## Revised Plan Sections

See the updated plan file at `docs/plans/2026-04-06-hybrid-architecture-improvements.md` -- all FIXED changes have been applied directly.
