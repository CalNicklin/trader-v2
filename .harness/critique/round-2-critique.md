# Critique -- Round 2

## Verdict: MINOR_ONLY

## Round 1 Fix Verification

### HIGH Issues

1. **#1 `MutationProposal` and `ValidatedMutation` types do not accept `"structural"`** -- FIXED. Step 3a now explicitly updates both interfaces in `src/evolution/types.ts` with `"structural"` added to the union type. The code shown is correct and matches the existing type structure.

2. **#2 DB schema enum does not include `"structural"` mutation type** -- FIXED. Step 3b adds `"structural"` to the `strategyMutations.mutationType` enum in `src/db/schema.ts` and updates the spawner cast. The Resolver correctly notes that SQLite text columns have no actual enum constraint, so no migration is needed -- just the Drizzle type definition. Verified against the current schema at line 218-219 which shows the existing `["parameter_tweak", "new_variant", "code_change"]` enum.

3. **#3 `callClaude` does not exist anywhere in the codebase** -- FIXED. Both the dispatch runner (Task 4 Step 6) and the eval harness (Task 6 Step 3) now use `new Anthropic()` + `client.messages.create()` with `withRetry` and `recordUsage`. Verified that `withRetry` is exported from `src/utils/retry.ts` with the correct signature `(fn, label, options?)` and `recordUsage` is exported from `src/utils/token-tracker.ts` with the correct signature `(job, inputTokens, outputTokens, ...)`.

4. **#4 `getPerformanceLandscape()` returns a `PerformanceLandscape` object, not an array** -- FIXED. The dispatch runner now correctly uses `landscape.strategies.filter(...)` instead of `graduated.filter(...)`. Verified against the current `PerformanceLandscape` type at line 42-46 of `types.ts`.

5. **#10 Dispatch layer has no integration with the evaluator** -- FIXED. Step 6b adds evaluator integration with an in-memory cache pattern (`getLatestDispatchDecisions()`, `clearDispatchDecisions()`) and modifies `evaluateAllStrategies()` to filter graduated strategy-symbol pairs. The fallback behavior (evaluate all symbols when no dispatch decisions exist) is correct.

6. **#12 Kill test assumes `checkDailyHalt` exists but it does not** -- FIXED. The kill test now correctly uses `isTradingHalted()` from `src/risk/guardian.ts` and checks `result.halted`, `result.requiresManualRestart`, and `result.reason`. Verified against the actual `isTradingHalted()` return type at line 110-133 of `guardian.ts`. The test sets the `daily_halt_active` risk state key, which is exactly what `isTradingHalted()` reads.

### MEDIUM Issues

All 8 MEDIUM issues were addressed:
- **#5** `canAffordCall` now called with single argument `(0.02)` -- correct.
- **#6** `db` import now uses `getDb()` from `"../db/client"` -- correct.
- **#7** Logger now uses `createChildLogger` pattern everywhere -- correct.
- **#8** Weekly evolution return type preserved with empty/zero values and explanatory comment -- correct.
- **#9** Pushed back with sound reasoning: graduation is an absolute quality gate, tournaments are relative comparisons needing more data. The interaction is intentional, not a bug.
- **#11** Regime signals documented as known limitation with follow-up condition -- adequate.
- **#13** Kill test now uses `getDb()` and async patterns -- correct.
- **#14** `StrategyPerformance` import fixed to `"../evolution/types"`, `s.description` replaced with `s.name` and signal descriptions -- correct. Verified that `StrategyPerformance` has `name` (line 3) and `signals` (line 9) but no `description` field.

## New/Remaining Structural Issues

None at HIGH severity.

## Minor Issues

1. **Graduation test in Task 5 inserts `paperTrades` with wrong column names.** The test uses `entryPrice` as a column name in the insert, but the `paper_trades` table has `price` (not `entryPrice`) and requires `quantity` and `signalType` (which are `.notNull()`). The `entryPrice` field is on `paper_positions`, not `paper_trades`. The insert also omits `signalType`, which has no default and is `.notNull()`. This will cause a runtime error when inserting the 20 paper trades needed for walk-forward validation.
   - **Severity:** MEDIUM (but scoped to a test, not production code)
   - **Fix:** Change `entryPrice: 150` to `price: 150` and add `signalType: "exit"` to the insert values.

2. **Structural mutation validation uses `evalExpr` which swallows parse errors.** Step 3c calls `evalExpr(expr, testCtx)` and wraps it in try/catch to detect invalid expressions. But `evalExpr` already catches all errors internally and returns `false` -- it never throws. So the try/catch in the validator will never catch anything, and invalid expressions will silently pass validation (the function returns `false`, not an exception). The validator should use the `Parser` class directly or `tokenize()` to detect parse errors, since those do throw.
   - **Severity:** MEDIUM
   - **Fix:** Either call `tokenize(expr)` directly (which throws on bad input) or import a validation-specific function that does not swallow errors.

3. **Task 2 Step 3: `runDailyTournaments` calls `checkDrawdowns()` which returns `number[]`, but the code assigns it to a variable and logs `drawdownKills` as a count.** The code does `const drawdownKills = await checkDrawdowns()` then `log.info({ kills: drawdownKills }, ...)`. This will log the full array of killed IDs, not a count. This is cosmetic -- the code works, but the log message says "Drawdown kills executed" with `kills` set to an array. Should be `kills: drawdownKills.length`.
   - **Severity:** LOW

4. **The evaluator integration in Step 6b uses `inArray` but does not add the import.** The code uses `inArray(strategies.status, graduatedStatuses)` but the existing `evaluator.ts` only imports `eq` from `drizzle-orm`. The `inArray` import needs to be added. This is present in the codebase elsewhere (`universe.ts`, `executor.ts`) so the pattern is correct, just the import is missing from the step's instructions.
   - **Severity:** LOW

5. **Known Limitations section #3 is stale.** It says "Graduation test uses `checkGraduationGate(metrics)` which is not the actual function signature" -- but the actual Task 5 test code (Steps 1-2) was already rewritten to use `checkGraduation(strategyId)` with DB inserts. The Known Limitations section describes a problem that was already fixed in the plan itself.
   - **Severity:** LOW (documentation inconsistency)

## What's Good

The Round 1 fixes are genuine and complete. The Resolver did not paper over problems -- the Anthropic SDK usage matches the codebase pattern, the type updates are in the right files, and the evaluator integration addresses the "dead code" problem that was the most critical issue. The kill test now correctly exercises the actual risk functions with the actual return types. The pushed-back issue (#9, tournament vs graduation thresholds) has valid reasoning that demonstrates understanding of the system's design intent. The plan is implementable as written, with the minor issues above being straightforward to catch during implementation.
