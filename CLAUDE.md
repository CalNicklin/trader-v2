# Trader v2 — Development Guide

## Project Status

**Spec:** `docs/specs/2026-04-03-trader-v2-design.md` — the masterplan for the entire system.

**Current state:** Phases 1–6 and 9 are built and deployed on Hetzner (systemd + GitHub Actions CI/CD). The paper trading loop is running with richer signal classification, universe management, learning loop feedback, self-improvement PRs, and monitoring.

### Implementation Plans

Execute in dependency order. Phases 5, 6, 9 can run in parallel. Phase 7 depends on 5 & 6. Phase 8 depends on 7.

| Phase | Plan | Status | What It Builds |
|-------|------|--------|----------------|
| 1 | `docs/plans/2026-04-03-phase1-foundation.md` | **Done** | DB, utils, config, scheduler, quotes |
| 2 | `docs/plans/2026-04-03-phase2-paper-lab.md` | **Done** | Paper trading engine, signals, metrics, graduation gate |
| 3 | `docs/plans/2026-04-03-phase3-news-event-bus.md` | **Done** | Finnhub → pre-filter → Haiku classifier → sentiment |
| Evals | `docs/plans/2026-04-04-ai-evals.md` | **Done** | Eval harness, classifier/pre-filter/pipeline/evolution suites |
| 4 | `docs/plans/2026-04-04-phase4-strategy-evolution.md` | **Done** | Autonomous parameter mutation, tournaments, population |
| **5** | `docs/plans/2026-04-04-phase5-learning-loop.md` | **Done** | Trade review, pattern analysis, graduation reasoning, meta-evolution |
| **6** | `docs/plans/2026-04-04-phase6-news-signals-seeds-universe.md` | **Done** | Richer classification, seed updates, universe management |
| **7** | `docs/plans/2026-04-04-phase7-broker-live-executor.md` | **Next** | IBKR broker cherry-pick from v1, live executor, settlement |
| **8** | `docs/plans/2026-04-04-phase8-risk-hard-limits.md` | Pending | All hard risk limits, ATR position sizing, demotion/kill |
| **9** | `docs/plans/2026-04-04-phase9-monitoring-self-improvement.md` | **Done** | Health endpoint, heartbeat, weekly digest, self-improvement PRs |

Plans are task-by-task with full code, TDD steps, and exact file paths. An agent can execute a plan by reading it and following the tasks sequentially.

## Stack
- **Runtime**: Bun (not Node.js, no dotenv)
- **Language**: TypeScript (strict)
- **Linter**: Biome (tab indentation)
- **DB**: SQLite via `bun:sqlite` + Drizzle ORM
- **Tests**: `bun test --preload ./tests/preload.ts`
- **Deploy**: GitHub Actions only (push to `main`) — never deploy manually via SSH

## Eval-Driven Development (REQUIRED)

Every AI-facing feature MUST include evaluations. Define eval tasks BEFORE implementation, not after.

### What needs evals
Any component where an LLM produces output that drives decisions:
- Strategy evaluation (does the agent identify good/bad setups?)
- News classification (sentiment accuracy, tradeability detection)
- Trade decisions (entry/exit quality, risk assessment)
- Day plan generation (signal quality, actionability)
- Graduation decisions (is the agent promoting the right strategies?)

### Eval structure
```
src/evals/
  <domain>/
    tasks.ts        # Task definitions with inputs + expected outcomes
    graders.ts      # Code-based and LLM-as-judge graders
    harness.ts      # Runner: clean env per trial, logs transcripts
    results/        # Historical eval results for tracking
```

### Eval design principles
1. **Start with 20-50 tasks** from real failures, production logs, or synthetic edge cases
2. **Grade outcomes, not paths** — don't require specific tool-call sequences
3. **Use code graders first** (JSON shape, field constraints, score ranges, token counts) — fast, cheap, reproducible
4. **Use LLM-as-judge for what code can't reach** (reasoning quality, signal interpretation) — structured rubric, one dimension per call
5. **Run multiple trials** (>=3 for capability evals) — model output is non-deterministic
6. **Balance positive and negative cases** — test both "should trigger" and "should NOT trigger"
7. **Track metrics**: pass rate, latency, token usage, cost per task, error rate
8. **Capability evals graduate to regression suite** when they reach high pass rates
9. **Run regression evals on every deploy** via CI

### In plans
Every phase plan that includes AI components must have:
- An eval task defining the eval suite for that phase's AI behaviour
- Specific grader designs (code-based + LLM-as-judge where needed)
- Reference solutions proving tasks are solvable
- Integration into the deploy pipeline

### The flywheel
```
Evals -> identify weakness -> improve prompt/model -> re-eval -> confirm improvement
  ^                                                                    |
  <-------- production feedback (agent_logs, error reports) <----------
```

## Cost Control
- All LLM calls go through budget guard (`canAffordCall`)
- `token_usage` table tracks all API spend
- Haiku for fast/cheap tasks, Sonnet for complex reasoning
- Daily budget enforced via `DAILY_API_BUDGET_USD`

## VPS Operations
- **Host**: Hetzner VPS, systemd service `trader-v2`, code at `/opt/trader-v2`
- **SSH**: `./scripts/vps-ssh.sh` (interactive) or `./scripts/vps-ssh.sh "command"`
- **Logs**: `./scripts/vps-logs.sh` (last 100), `./scripts/vps-logs.sh -f` (live tail), `./scripts/vps-logs.sh --since "1 hour ago"`
- **Status**: `./scripts/vps-status.sh` (systemd status + health endpoint)
- **Health**: `http://<VPS_HOST>:3847/health` (JSON), `http://<VPS_HOST>:3847/` (HTML dashboard)
- **Restart**: `./scripts/vps-ssh.sh "sudo systemctl restart trader-v2"`
- Credentials read from `.env` (VPS_HOST, VPS_USER, VPS_SSH_KEY)

## Key Conventions
- LSE prices are in **pence** (GBp), not pounds
- Drizzle enum columns need exact union type when inserting
- Use `$defaultFn` for auto-generated timestamps
- Use `onConflictDoUpdate/DoNothing` for idempotent operations
