# Critique -- Round 1

## Verdict: ISSUES

## Structural Issues

1. **`MutationProposal` and `ValidatedMutation` types do not accept `"structural"`**
   - **Where:** Task 1, Step 3
   - **Problem:** The plan says to add `structural` as a mutation type, but the existing `MutationProposal` type in `src/evolution/types.ts` is `type: "parameter_tweak" | "new_variant"` and `ValidatedMutation` is `type: "parameter_tweak" | "new_variant"`. The plan never updates these type definitions. The code in `validateMutation()` already pattern-matches on `proposal.type`, and TypeScript will reject `"structural"` at compile time. The plan only says "Add to MutationProposal type (or wherever the type is defined)" as a comment in a code block -- this is not an actual implementation step with a file path or diff.
   - **Severity:** HIGH
   - **Why it matters:** Every test in Task 1 will fail to compile. The implementer will have to reverse-engineer what to change in `types.ts` and may also miss that `ValidatedMutation` needs the same update.

2. **DB schema enum does not include `"structural"` mutation type**
   - **Where:** Task 1, Step 6 (spawner)
   - **Problem:** The `strategyMutations` table defines `mutationType` as `text("mutation_type", { enum: ["parameter_tweak", "new_variant", "code_change"] })`. The spawner (`spawnChild`) inserts `mutation.type` as the `mutationType` value. If a `structural` mutation is spawned, it will attempt to insert `"structural"` into a column whose Drizzle enum only allows `"parameter_tweak" | "new_variant" | "code_change"`. This will fail at the TypeScript level (type mismatch) and possibly at the DB constraint level. The plan says "verify it handles custom parameter names" but misses the enum problem entirely.
   - **Severity:** HIGH
   - **Why it matters:** Structural mutations will fail to persist. The spawner's `mutationType: mutation.type as "parameter_tweak" | "new_variant" | "code_change"` cast will mask the type error at compile time but the logical mismatch remains -- `"structural"` is not in the enum. Either the schema needs a migration or `structural` needs to map to an existing enum value.

3. **`callClaude` does not exist anywhere in the codebase**
   - **Where:** Task 4, Steps 5-6; Task 6, Step 3
   - **Problem:** The dispatch runner and eval harness import `callClaude` from `"../utils/claude"` and `"../../utils/claude"`. This function does not exist. The existing codebase uses the Anthropic SDK directly (see `src/evolution/index.ts` which creates `new Anthropic()` and calls `client.messages.create()`). The plan invents a utility function without defining it or noting that it needs to be created.
   - **Severity:** HIGH
   - **Why it matters:** Task 4 and Task 6 cannot be implemented as written. The implementer must either create a `callClaude` wrapper (adding scope not in the plan) or rewrite the dispatch/eval code to use the raw Anthropic SDK pattern, which changes the shape of the code significantly.

4. **`getPerformanceLandscape()` returns a `PerformanceLandscape` object, not an array**
   - **Where:** Task 4, Step 6
   - **Problem:** The dispatch runner calls `const graduated = await getPerformanceLandscape()` then `graduated.filter(...)`. But `getPerformanceLandscape()` returns `{ strategies: StrategyPerformance[], activePaperCount: number, timestamp: string }` -- an object, not an array. You cannot call `.filter()` on it. It should be `graduated.strategies.filter(...)`.
   - **Severity:** HIGH
   - **Why it matters:** Runtime crash. The dispatch runner will throw `graduated.filter is not a function` on every invocation.

5. **`canAffordCall` signature mismatch in dispatch**
   - **Where:** Task 4, Step 6
   - **Problem:** The plan calls `canAffordCall(0.02, "dispatch")` with two arguments (cost, label). The actual signature in `src/utils/budget.ts` is `canAffordCall(estimatedCost: number, db?: DbClient)` -- the second parameter is an optional database client, not a string label. Passing `"dispatch"` as a DB client will cause a type error.
   - **Severity:** MEDIUM
   - **Why it matters:** TypeScript compilation failure. Easy to spot and fix but wastes implementer time.

6. **`db` import pattern wrong in dispatch runner**
   - **Where:** Task 4, Step 6
   - **Problem:** The plan imports `{ db } from "../db"` as a direct export. The codebase uses `getDb()` from `"../db/client"` to get the database instance (see every other file: `evaluator.ts`, `tournament.ts`, `spawner.ts`, etc.). There is no `db` named export from `"../db"`. The dispatch runner also imports `{ strategies, newsEvents, quotesCache }` from `"../db/schema"` but the code as written uses `db.select()...` directly without calling `getDb()`.
   - **Severity:** MEDIUM
   - **Why it matters:** Import will fail. The implementer needs to change to the `getDb()` pattern used everywhere else.

7. **`log` import pattern wrong in dispatch and tournament additions**
   - **Where:** Task 2, Step 3; Task 4, Step 3
   - **Problem:** Task 2 imports `{ log } from "../utils/logger"` and Task 4 imports `{ log } from "../utils/logger"`. The logger module exports `createChildLogger`, not a bare `log`. Every module in the codebase creates its own child logger: `const log = createChildLogger({ module: "..." })`. The plan's import will fail.
   - **Severity:** MEDIUM
   - **Why it matters:** Both Task 2 and Task 4 code will fail to compile as written.

8. **Daily tournament removes steps 1-3 from weekly evolution but breaks its return type contract**
   - **Where:** Task 2, Step 6
   - **Problem:** The plan says to remove `checkDrawdowns()`, `runTournaments()`, and `enforcePopulationCap()` from `runEvolutionCycle()`. But the function returns `{ drawdownKills: number[], tournaments: number, populationCulls: number[], spawned: number[] }`. Removing those calls means `drawdownKills`, `tournaments`, and `populationCulls` fields would need to be set to empty/zero values. Any callers or tests that check these return values after the weekly evolution job will break. The plan does not address the return type.
   - **Severity:** MEDIUM
   - **Why it matters:** Existing tests for `runEvolutionCycle()` likely assert on the returned fields. Silently zeroing them without updating tests creates confusion.

9. **Tournament `MIN_TRADES_FOR_TOURNAMENT` stays at 30 while graduation drops to 20**
   - **Where:** Task 2 + Task 5, cross-cutting
   - **Problem:** `src/evolution/tournament.ts` requires `MIN_TRADES_FOR_TOURNAMENT = 30` samples before resolving a parent-child pair. The graduation gate is being reduced to 20 trades. This means a strategy could theoretically graduate (20 trades, good metrics) before its tournament against the parent is resolved (requires 30 trades each). The plan never considers whether the tournament threshold should also be adjusted to align with the new graduation gate.
   - **Severity:** MEDIUM
   - **Why it matters:** Strategies could graduate to probation while their parent-child tournament is still pending. The interaction between these two systems is unaddressed and could lead to a graduated child being killed retroactively by a tournament it already "passed" via graduation.

10. **Dispatch layer has no integration with the evaluator**
    - **Where:** Task 4, cross-cutting
    - **Problem:** The spec's "Recommended next steps" step 4 says dispatch decisions should determine which strategies activate on which symbols. The plan creates a dispatch runner that produces `DispatchDecision[]` and registers it as a scheduler job, but never modifies `evaluateAllStrategies()` in `src/strategy/evaluator.ts` to consume those decisions. The evaluator currently evaluates ALL paper strategies on ALL their universe symbols unconditionally. The dispatch decisions are generated and logged but never read by anything. Task 4's file list says "Modify: `src/strategy/evaluator.ts` -- respect dispatch decisions" but no step in Task 4 actually modifies the evaluator.
    - **Severity:** HIGH
    - **Why it matters:** The dispatch layer is dead code. It generates decisions that nothing reads. The entire purpose of dispatch (selecting which strategy-symbol pairs to evaluate) is not achieved. This is the core deliverable of the plan's most novel feature.

11. **Regime signals are never actually computed from real data**
    - **Where:** Task 3 + Task 4, cross-cutting
    - **Problem:** Task 3 creates the regime detection functions and wires them into `buildSignalContext()` as an optional input. But the evaluator (`evaluateAllStrategies`) never calls `detectRegime()` or passes regime data into `buildSignalContext()`. Task 4's dispatch runner hardcodes `atr_percentile: 50, volume_breadth: 0.5, momentum_regime: 0.5` with TODO comments. So regime signals are: (a) available in the context type but never populated for actual strategy evaluation, and (b) hardcoded to neutral values for dispatch. The feature is a shell.
    - **Severity:** MEDIUM
    - **Why it matters:** Any structural strategy that uses regime signals in its expressions (e.g., `momentum_regime > 0.7 AND ...`) will get constant neutral values and never fire meaningfully. The dispatch prompt will always see a neutral regime and cannot make regime-aware decisions. The plan implies this is a "TODO" but does not create a follow-up task or document it as a known limitation.

12. **Kill test assumes `checkDailyHalt` exists but it does not**
    - **Where:** Task 7, Step 1
    - **Problem:** The kill test imports `{ checkDailyHalt } from "../../src/risk/guardian"`. Grepping the risk/guardian module shows `isTradingHalted` is the exported function, not `checkDailyHalt`. No function named `checkDailyHalt` exists in the codebase.
    - **Severity:** HIGH
    - **Why it matters:** The kill test -- which is a safety-critical acceptance criterion from the debate -- will fail to compile. The implementer must figure out the correct function name and may need to restructure the test around `isTradingHalted`'s different return type (`{ halted, requiresManualRestart, reason }` vs a boolean).

13. **Kill test uses synchronous `db` import and `.run()` calls**
    - **Where:** Task 7, Step 1
    - **Problem:** The kill test imports `{ db } from "../../src/db"` (wrong pattern, should be `getDb()`) and uses `db.insert(...).run()`, `db.delete(...).run()`. While Bun's SQLite is synchronous, the codebase uses `await` with Drizzle consistently. More critically, the `db` import does not exist as shown.
    - **Severity:** MEDIUM
    - **Why it matters:** Import failure. Fixable but adds friction to implementing the safety-critical test.

14. **Dispatch prompt references `StrategyPerformance` from `../evolution/analyzer` but needs it from `../evolution/types`**
    - **Where:** Task 4, Step 5
    - **Problem:** The dispatch prompt file imports `type { StrategyPerformance } from "../evolution/analyzer"`. The type is defined in `src/evolution/types.ts` and re-exported via the analyzer module. While this might work if analyzer re-exports it, the canonical location is `types.ts`. More importantly, the prompt function accesses `s.description` on `StrategyPerformance`, but looking at the type definition, there is no `description` field on `StrategyPerformance` (it has `name`, `status`, `generation`, `parameters`, `signals`, etc.). The strategy table has a `description` column but it is not surfaced through the `StrategyPerformance` type.
    - **Severity:** MEDIUM
    - **Why it matters:** `s.description` will be `undefined` in the prompt, producing broken prompt text like `"undefined"` where strategy descriptions should appear. The dispatch LLM will get degraded context.

## Minor Issues

- **Dispatch eval harness has only 3 tasks:** The project convention says "Start with 20-50 tasks." Three tasks are a skeleton, not a suite. Acceptable as a starting point but the plan should acknowledge the gap.
- **No `prompt.ts` file changes shown for Task 1 Step 5:** The step says "update the mutation types section" but the code shown is just a string template, not a diff against the existing prompt. The implementer has to find and understand `buildEvolutionPrompt()` to know where to insert it.
- **Daily tournament at 21:35 collides with pattern analysis at 21:30 on Tue/Fri:** The global `jobRunning` mutex means one will be skipped. The plan says "check the exact times and pick an open slot" but then picks 21:35, which is only 5 minutes after pattern_analysis starts. If pattern analysis takes more than 5 minutes, the tournament will be skipped.
- **Graduation test in Task 5 calls `checkGraduationGate(metrics)` which is not the actual function signature:** The real function is `checkGraduation(strategyId: number)` which reads metrics from the DB. The test cannot pass metrics directly. It would need to insert a strategy + metrics into the test DB first.

## What's Good

The plan's task decomposition follows the spec's recommended steps in the right dependency order, and the eval-driven approach for the dispatch layer is correctly scoped. The decision to keep exits mechanical and limit Claude to dispatch (not execution) faithfully implements the debate's convergence.