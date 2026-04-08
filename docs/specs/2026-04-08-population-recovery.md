# Population Recovery Design Spec

## Problem

When strategies are killed (drawdown > 15%), population can drop below viable levels. The evolution cycle requires 30+ trades from at least one paper strategy to propose mutations — if no strategy meets this threshold, evolution skips and the system is stuck with a shrinking or stagnant population indefinitely.

Current state: `gap_fade_v1` killed 2026-04-08 (15.92% drawdown), population at 2/8, both remaining strategies have <2 trades. Evolution will skip every Sunday until one accumulates 30 trades — weeks of lost learning.

## Solution

Two-layer population recovery. The VPS-side evolution cycle gets a population floor for immediate autonomous response. The GitHub Actions self-improvement agent gets population awareness for root-cause investigation.

### Layer 1: VPS-side evolution floor

**Trigger:** `activePaperCount < MIN_POPULATION` (3)

When population is critically low, the evolution cycle bypasses the 30-trade gate and enters recovery mode:

- `MIN_POPULATION = 3` added to `src/evolution/population.ts`
- In `src/evolution/index.ts`, before the 30-trade check (line 96), check `activePaperCount < MIN_POPULATION`. If true, skip the trade-count filter and set `recoveryMode = true`
- In `src/evolution/prompt.ts`, `buildEvolutionPrompt` accepts an optional `recoveryMode` boolean. When true, append to the task section: "POPULATION CRITICAL: Only {N}/8 strategies active. Propose structural mutations — new signal logic, different entry/exit approaches, fresh universes. Prioritise diversity over data-driven tuning."
- Recovery spawns capped at `Math.min(2, slotsAvailable)` per cycle (not filling all available slots)
- Recovery spawns tagged with `createdBy: "evolution:recovery"` via `spawnChild`

**Files changed:**
- `src/evolution/population.ts` — add `MIN_POPULATION` export
- `src/evolution/index.ts` — add recovery mode bypass before 30-trade check, cap spawns at 2 in recovery mode
- `src/evolution/prompt.ts` — accept `recoveryMode` param, add critical population prompt text
- `src/evolution/spawner.ts` — accept optional `createdBy` param (default `"evolution"`)

### Layer 2: Self-improvement agent population awareness

Add a population health focus area to the `claude.yml` prompt:

```
- Population health — if activePaperCount is below 4, this is a CRITICAL priority.
  Investigate why strategies are being killed faster than created. Check graduation
  events for patterns (are kill thresholds too aggressive for current volatility?
  Are young strategies being culled before accumulating meaningful data?). Consider:
  adjusting DRAWDOWN_KILL_PCT, adding tournament protection for strategies with <10
  trades, writing new seed strategies with battle-tested parameters, or tuning the
  evolution floor's recovery spawn logic if you see repeated spawn-kill churn.
```

No code changes to the agent. The landscape dump from `dump-landscape.ts` already includes strategy statuses, graduation events, mutation history, and `createdBy` fields. Opus can see `"evolution:recovery"` strategies and reason about whether recovery spawns are surviving or churning.

**Files changed:**
- `.github/workflows/claude.yml` — add population health paragraph to focus areas

### What we're NOT doing

- No new database tables or migrations — `createdBy` is already a text column
- No changes to the daily tournament or drawdown kill logic
- No explicit tagging/exclusion coordination between evolution and self-improvement
- No changes to the 30-trade threshold itself — only bypassed in recovery mode
- No population floor management by the self-improvement agent — it observes and fixes root causes

## Testing

- **Unit test: population floor triggers recovery mode** — verify `runEvolutionCycle` calls the API when `activePaperCount < MIN_POPULATION` with 0 trades, caps spawns at 2
- **Unit test: recovery prompt content** — verify `buildEvolutionPrompt(landscape, true)` includes "POPULATION CRITICAL" text
- **Unit test: `spawnChild` createdBy override** — verify the param flows to the inserted row
- **Existing tests unchanged** — 30-trade gate still applies in normal mode

## Design rationale

See `docs/debates/2026-04-08-population-recovery.md` for the full 5-round debate between three advocates (A: VPS-only, B: GitHub Actions-only, C: both). All three converged on Approach C:

- The evolution floor is the fast pressure valve (autonomous, same-cycle recovery)
- The self-improvement agent is the slow engineer (root-cause diagnosis, structural fixes)
- Neither substitutes for the other
