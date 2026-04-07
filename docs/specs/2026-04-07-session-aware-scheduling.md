# Session-Aware Scheduling — Design Spec

**Date:** 2026-04-07
**Status:** Approved
**Author:** Cal + Claude

## Problem

The current CRON schedule treats 08:00–20:59 UK time as a single flat trading window. This causes several issues:

1. **US market underserved** — activity stops at 20:59, missing the last hour of US trading (closes 21:00 UK). No awareness of US open at 14:30 UK.
2. **No session differentiation** — UK-only, overlap, and US-only periods all treated identically. Strategies evaluate all symbols regardless of which exchange is open.
3. **Dispatch timing suboptimal** — fires at 09:00, 12:00, 15:00 UK. No dispatch at US open (14:30) or UK close handoff (16:30). No US afternoon dispatch.
4. **Uniform polling frequency** — 10 min everywhere. During overlap, both markets poll independently but no stagger, so no effective frequency gain.
5. **Post-close contention** — batch analysis jobs (21:00–21:45) overlap with US market close, competing for the global job lock during critical final fills.
6. **Global job lock** — single `jobRunning` boolean means only one job runs at a time. With per-market jobs, the staggered UK/US pipelines would collapse into serial execution.

## Design

### 1. Named Trading Sessions

Define explicit sessions as a static lookup table in `src/scheduler/sessions.ts`:

```typescript
type SessionName =
  | "pre_market"
  | "uk_session"
  | "overlap"
  | "us_session"
  | "us_close"
  | "post_close"
  | "off_hours";

type Exchange = "LSE" | "NASDAQ" | "NYSE";

interface Session {
  name: SessionName;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  exchanges: Exchange[];
  allowNewEntries: boolean;
}
```

| Session | Hours (UK) | Exchanges | New Entries | Purpose |
|---------|-----------|-----------|-------------|---------|
| `pre_market` | 06:00–07:59 | — | No | News intelligence gathering |
| `uk_session` | 08:00–14:29 | LSE | Yes | UK-only trading |
| `overlap` | 14:30–16:29 | LSE, NASDAQ, NYSE | Yes | Both markets open |
| `us_session` | 16:30–20:59 | NASDAQ, NYSE | Yes | US-only trading |
| `us_close` | 21:00–21:14 | NASDAQ, NYSE | No (exits only) | Final fills, stop triggers |
| `post_close` | 22:00–22:45 | — | No | Batch analysis |
| `off_hours` | 22:46–05:59 | — | No | Idle |

A `getCurrentSession()` function checks the current UK time against this table and returns the active session. All jobs call this to scope their work.

### 2. Per-Market Quote & Evaluation Cycles

Each exchange keeps its own independent 10-minute polling cycle. During overlap, the two cycles are staggered by 5 minutes, giving ~5-minute effective coverage without increasing per-market load.

**Quote refresh:**

| Job | Schedule (UK) | Scope |
|-----|---------------|-------|
| `quote_refresh_uk` | `*/10 8-16 * * 1-5` | LSE/AIM symbols only |
| `quote_refresh_us` | `5,15,25,35,45,55 14-20 * * 1-5` | NASDAQ/NYSE symbols only |
| `quote_refresh_us_close` | `*/5 21 * * 1-5` | US symbols, tight polling for final fills. Cron fires every 5 min in the 21:xx hour; the job checks `getCurrentSession()` and no-ops if session is not `us_close` (i.e. after 21:14). |

**Strategy evaluation (fires 3 min after respective quotes):**

| Job | Schedule (UK) | Scope |
|-----|---------------|-------|
| `strategy_eval_uk` | `3,13,23,33,43,53 8-16 * * 1-5` | UK strategies/symbols only |
| `strategy_eval_us` | `8,18,28,38,48,58 14-20 * * 1-5` | US strategies/symbols only |

During overlap (14:30–16:29), the timeline every 10 minutes looks like:

```
:00  quote_refresh_uk
:03  strategy_eval_uk
:05  quote_refresh_us
:08  strategy_eval_us
```

UK and US pipelines run independently via per-category locks (see Section 4).

### 3. Full CRON Schedule

**Per-market trading pipelines:**

| Job | Schedule (UK) | Lock Category |
|-----|---------------|---------------|
| `quote_refresh_uk` | `*/10 8-16 * * 1-5` | `quotes_uk` |
| `quote_refresh_us` | `5,15,25,35,45,55 14-20 * * 1-5` | `quotes_us` |
| `quote_refresh_us_close` | `*/5 21 * * 1-5` | `quotes_us` |
| `strategy_eval_uk` | `3,13,23,33,43,53 8-16 * * 1-5` | `eval_uk` |
| `strategy_eval_us` | `8,18,28,38,48,58 14-20 * * 1-5` | `eval_us` |

**News polling:**

| Job | Schedule (UK) | Lock Category |
|-----|---------------|---------------|
| `news_poll` | `*/10 6-20 * * 1-5` | `news` |

News polling runs from 06:00 (pre-market intel) through 20:59 (end of US session). Single job covering all sources — the session context determines whether evaluation is triggered.

**Dispatch at session boundaries:**

| Job | Schedule (UK) | Lock Category | Why |
|-----|---------------|---------------|-----|
| `dispatch` | `5 8 * * 1-5` | `dispatch` | UK open |
| `dispatch` | `35 14 * * 1-5` | `dispatch` | US open / overlap start |
| `dispatch` | `35 16 * * 1-5` | `dispatch` | UK close / US-only handoff |
| `dispatch` | `0 18 * * 1-5` | `dispatch` | Mid US afternoon |

**Risk & guardian:**

| Job | Schedule (UK) | Lock Category |
|-----|---------------|---------------|
| `guardian_start` | `0 8 * * 1-5` | `risk` |
| `guardian_stop` | `15 21 * * 1-5` | `risk` |
| `risk_guardian` | `*/10 8-21 * * 1-5` | `risk` |
| `risk_daily_reset` | `55 7 * * 1-5` | `maintenance` |
| `risk_weekly_reset` | `50 7 * * 1` | `maintenance` |

Guardian stop extended to 21:15 to cover US close. Risk guardian runs through 21:xx to monitor final positions.

**Post-close analysis (pushed to 22:00+):**

| Job | Schedule (UK) | Lock Category |
|-----|---------------|---------------|
| `daily_summary` | `0 22 * * 1-5` | `analysis` |
| `trade_review` | `15 22 * * 1-5` | `analysis` |
| `missed_opportunity_daily` | `25 22 * * 1-5` | `analysis` |
| `daily_tournament` | `35 22 * * 1-5` | `analysis` |
| `pattern_analysis` | `45 22 * * 2,5` | `analysis` |
| `missed_opportunity_weekly` | `45 22 * * 3` | `analysis` |

**Pre-market & maintenance:**

| Job | Schedule (UK) | Lock Category |
|-----|---------------|---------------|
| `earnings_calendar_sync` | `0 6 * * 1-5` | `maintenance` |
| `heartbeat` | `0 7 * * 1-5` | `maintenance` |

**Weekend (unchanged):**

| Job | Schedule (UK) | Lock Category |
|-----|---------------|---------------|
| `weekly_digest` | `30 17 * * 0` | `analysis` |
| `strategy_evolution` | `0 18 * * 0` | `analysis` |
| `self_improvement` | `0 19 * * 0` | `analysis` |

### 4. Per-Category Job Locks

Replace the single `jobRunning` boolean with per-category locks in `src/scheduler/locks.ts`:

```typescript
type LockCategory =
  | "quotes_uk"
  | "quotes_us"
  | "news"
  | "eval_uk"
  | "eval_us"
  | "dispatch"
  | "analysis"
  | "risk"
  | "maintenance";
```

Each job declares its lock category. `runJob()` checks only its category's lock. This enables:

- UK and US quote/eval pipelines running fully in parallel
- News polling running in parallel with quote refresh
- Risk guardian running in parallel with everything (critical for stop-loss enforcement)
- Post-close analysis jobs running sequentially (shared `analysis` lock, staggered schedule)

Jobs within the same category are serialised — e.g. `quote_refresh_uk` cannot overlap itself. The 10-minute timeout per job is retained per-category.

### 5. Session Helper Usage

Jobs use the session to scope their work:

- **Quote refresh jobs** check `session.exchanges` — skip if their exchange isn't in the current session
- **Strategy evaluation jobs** filter symbol universe by session exchanges
- **`us_close` evaluation** checks `session.allowNewEntries === false` and only processes exit signals
- **News poll** runs across all sessions 06:00–20:59 but only triggers strategy evaluation if `session.evaluateStrategies` for the relevant exchange
- **Dispatch** receives the current session context to make informed strategy-symbol decisions

### 6. Files Changed

**New files:**
- `src/scheduler/sessions.ts` — session definitions, `getCurrentSession()`
- `src/scheduler/locks.ts` — per-category lock manager

**Modified files:**
- `src/scheduler/cron.ts` — new schedule with per-market jobs
- `src/scheduler/jobs.ts` — split quote/eval jobs by market, use category locks, new job names
- `src/monitoring/cron-schedule.ts` — update static schedule for dashboard

**Unchanged:**
- Job implementations (quote refresh, evaluator, etc.) — already work on symbol lists, just receive filtered sets
- Risk guardian, guardian start/stop — adjusted times only
- Weekend jobs — unchanged timing
- All strategy/evolution/learning-loop code — no changes
