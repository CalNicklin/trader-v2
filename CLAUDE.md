# Trader v2 — Development Guide

## Project Status

**Spec:** `docs/specs/2026-04-03-trader-v2-design.md` — the masterplan for the entire system.

**Current state:** All phases (1–9) are built and deployed on Hetzner (systemd + GitHub Actions CI/CD). The paper trading loop is running with richer signal classification, universe management, learning loop feedback, self-improvement PRs (Opus-powered), monitoring, and session-aware scheduling. IBKR broker integration and risk hard limits are fully implemented — live trading is gated behind `LIVE_TRADING_ENABLED=true` in the VPS `.env`. Strategies graduating from paper → probation will begin receiving capital allocation once live trading is enabled. Additional features deployed: hybrid architecture (structural evolution, dispatch, daily tournaments), news research agent (Sonnet deep-dive on tradeable events), missed opportunity tracker, session-aware per-market scheduling with parallel UK/US pipelines, and learning loop feedback (structured insight actions fed to evolution/self-improvement, `ledToImprovement` tracking).

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
| **7** | `docs/plans/2026-04-04-phase7-broker-live-executor.md` | **Done** | IBKR broker, live executor, settlement, stop-loss/trailing stops |
| **8** | `docs/plans/2026-04-04-phase8-risk-hard-limits.md` | **Done** | ATR position sizing, drawdown limits, demotion/kill, circuit breaker |
| **9** | `docs/plans/2026-04-04-phase9-monitoring-self-improvement.md` | **Done** | Health endpoint, heartbeat, weekly digest, self-improvement PRs |

### Post-Phase Improvements

| Feature | Plan/Spec | Status | What It Builds |
|---------|-----------|--------|----------------|
| Hybrid Architecture | `docs/plans/2026-04-06-hybrid-architecture-improvements.md` | **Done** | Structural evolution, Claude-driven dispatch, daily tournaments, regime detection |
| News Research Agent | `docs/plans/2026-04-07-news-research-intelligence.md` | **Done** | Sonnet deep-dive on tradeable events, multi-symbol analysis, missed opportunity tracker |
| Dashboard Tabs | `docs/plans/2026-04-07-dashboard-subsystem-tabs.md` | **Done** | Subsystem tabs for monitoring dashboard |
| Session-Aware Scheduling | `docs/plans/2026-04-07-session-aware-scheduling.md` | **Done** | Per-market UK/US pipelines, session boundaries, parallel job locks |
| Learning Loop Feedback | `docs/plans/2026-04-07-learning-loop-feedback.md` | **Done** | Structured insight actions in evolution/self-improvement prompts, `ledToImprovement` tracking, Opus for heavy reasoning |
| Universe Rollout | `docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md` | **In progress** — see `docs/universe-rollout-status.md` | 5-step rollout replacing static seed universes with catalyst-driven 4-tier architecture. Steps 1, 1a, 2 shipped. Data stack: iShares/Wikipedia/Yahoo/SEC EDGAR/Frankfurter/Finnhub — **FMP fully removed in PR #44**. Step 3 next. |

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
- Haiku for fast/cheap tasks, Sonnet for standard reasoning, Opus for evolution + self-improvement
- Daily budget enforced via `DAILY_API_BUDGET_USD`

## VPS Operations
- **Host**: Hetzner VPS, systemd service `trader-v2`, code at `/opt/trader-v2`
- **SSH**: `./scripts/vps-ssh.sh` (interactive) or `./scripts/vps-ssh.sh "command"`
- **Logs**: `./scripts/vps-logs.sh` (last 100), `./scripts/vps-logs.sh -f` (live tail), `./scripts/vps-logs.sh --since "1 hour ago"`
- **Status**: `./scripts/vps-status.sh` (systemd status + health endpoint)
- **Health**: `http://<VPS_HOST>:3847/health` (JSON), `http://<VPS_HOST>:3847/` (HTML dashboard)
- **Restart**: `./scripts/vps-ssh.sh "sudo systemctl restart trader-v2"`
- Credentials read from `.env` (VPS_HOST, VPS_USER, VPS_SSH_KEY)

## Scheduling Architecture

The system uses **session-aware scheduling** with named trading sessions (see `src/scheduler/sessions.ts`):

| Session | UK Time | Exchanges | Notes |
|---------|---------|-----------|-------|
| `pre_market` | 06:00–07:59 | — | News polling only |
| `uk_session` | 08:00–14:29 | LSE | UK quotes + eval every 10 min |
| `overlap` | 14:30–16:29 | LSE + NASDAQ/NYSE | Both markets, staggered 5 min apart |
| `us_session` | 16:30–20:59 | NASDAQ/NYSE | US quotes + eval every 10 min |
| `us_close` | 21:00–21:14 | NASDAQ/NYSE | Exits only, 5-min polling |
| `post_close` | 22:00–22:45 | — | Batch analysis jobs |

- **Per-category job locks** (`src/scheduler/locks.ts`) — UK and US pipelines run in parallel, not serialized
- **Dispatch** fires at session boundaries: 08:05, 14:35, 16:35, 18:00
- Schedule defined in `src/scheduler/cron.ts`, mirrored in `src/monitoring/cron-schedule.ts` (keep in sync)

## Key Conventions
- LSE prices are in **pence** (GBp), not pounds
- Drizzle enum columns need exact union type when inserting
- Use `$defaultFn` for auto-generated timestamps
- Use `onConflictDoUpdate/DoNothing` for idempotent operations
