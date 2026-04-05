# Ops Console Dashboard — Design Spec

## Overview

Replace the current minimal status page (`src/monitoring/status-page.ts`) with a dense, Bloomberg-terminal-inspired operations console. Server-rendered HTML served from the existing Bun HTTP server at `GET /`. Auto-refreshes every 30 seconds. No frontend framework — single HTML string built server-side with embedded CSS.

## Aesthetic

- **Font:** JetBrains Mono (Google Fonts CDN), fallback to Courier New
- **Background:** `#050505` (near-black), panels `#0a0a0a`
- **Palette:** amber `#f59e0b` for brand/highlights, green `#22c55e` for healthy, red `#ef4444` for errors, muted greys for secondary text
- **Grid dividers:** 1px `#1a1a1a` lines between panels (no card borders/shadows)
- **Information density:** everything visible without scrolling on a 1080p display; scrollable overflow only in activity log and cron panels

## Layout (top to bottom)

### 1. Status Bar (full width)

Left side:
- `TRADER V2` in amber, letter-spaced
- IBKR connection: green/red dot + account ID (e.g., `DUP924429`) or `DISCONNECTED`
- System status: green dot `OK` / amber `DEGRADED` / red `ERROR`
- Live strategy count: amber dot + `N LIVE`

Right side:
- Uptime: `UP 6h 14m`
- Current UTC time

**Data sources:** `isConnected()` from `broker/connection.ts`, `process.uptime()`. IBKR account ID from `getAccountSummary().accountId` (cached at boot, falls back to `—` if unavailable).

### 2. KPI Strip (6 columns, full width)

| KPI | Value Source | Sub-label |
|-----|-------------|-----------|
| Daily P&L | `risk_state` table, key `daily_pnl` | `limit: {config}p` |
| Weekly P&L | `risk_state` table, key `weekly_pnl` | `limit: {config}p` |
| Open Positions | `count(*)` from `live_positions` | First symbol or `—` |
| Trades Today | `count(*)` from `live_trades` where `created_at` is today | `—` |
| API Spend | `getDailySpend()` from `utils/budget.ts` | `budget: ${DAILY_API_BUDGET_USD}` |
| Last Quote | Most recent `updated_at` from `quotes_cache` | `weekend` if >1h stale on weekday |

Color rules: green if healthy/positive, amber if warning, red if limit breached, dim grey if zero/inactive.

### 3. Strategy Pipeline (full width)

**Visual pipeline:** Horizontal row of tier boxes connected by `→` arrows:

```
[3 Paper] → [0 Probation] → [0 Active] → [0 Core]     [0 Retired]
```

Each box shows count + tier name. Color-coded borders per tier.

**Strategy table** below the pipeline:

| Column | Source |
|--------|--------|
| Name | `strategies.name` |
| Status | `strategies.status` — color-coded |
| Win Rate | `strategy_metrics.winRate` or `—` |
| Sharpe | `strategy_metrics.sharpeRatio` or `—` |
| Trades | `count(*)` from `paper_trades` for this strategy |
| Universe | First 3 symbols from `strategies.universe` JSON |

Query: `strategies` LEFT JOIN `strategy_metrics` on `strategy_id`, filtered to non-retired. Order by status tier (core first, paper last).

### 4. Bottom Three Panels (equal width columns)

#### 4a. Left: Positions + Risk

**Live Positions table:**

| Column | Source |
|--------|--------|
| Symbol | `live_positions.symbol:exchange` |
| Side | SHORT if `quantity < 0`, LONG otherwise — red/green |
| Qty | `abs(live_positions.quantity)` |
| Avg Cost | `live_positions.avgCost` |
| P&L | `live_positions.unrealizedPnl` or `—` |
| Tag | `orphan` if `strategyId` is null |

**Risk Limits** (below positions):

Three horizontal bars showing usage vs limit:
- Daily P&L: current / daily limit from config
- Weekly P&L: current / weekly limit from config
- Max Positions: count / max from config

Bar color: green <50%, amber 50-80%, red >80%.

**Pause/Resume button:** Same behavior as current implementation — `POST /pause` and `POST /resume`.

#### 4b. Center: Cron Schedule

Table of all 17 cron jobs showing:

| Column | Source |
|--------|--------|
| Time | Parsed from cron expression (next occurrence, London time) |
| Job | Job name |
| Last | Last run status — `✓ ok`, `✗ err`, or `—` if never run |
| Next In | Countdown to next run |

**Data source for "last run":** Every completed job calls `sendHeartbeat(name)` (see `jobs.ts`). Query `agent_logs` for the most recent entry where `phase` matches the job name. If no entry exists, show `—`. If the most recent entry's level is `ERROR`, show `✗ err`. Otherwise `✓ ok`.

**Next run calculation:** Define a static schedule map in the dashboard data module — `Record<JobName, { cron: string }>` — mirroring the cron expressions from `src/scheduler/cron.ts`. Write a helper `getNextCronOccurrence(cronExpr: string, timezone: string): Date` using the `cron-parser` npm package. The patterns are all simple (no complex ranges).

Sort by next occurrence (soonest first). Highlight the next 3 upcoming jobs with amber text.

#### 4c. Right: Activity Log

Most recent 20 entries from `agent_logs` table, ordered by `created_at` DESC.

| Column | Source |
|--------|--------|
| Time | `created_at` formatted as `HH:MM` |
| Level | `level` — color-coded: INFO=blue, WARN=amber, ERROR=red, ACTION=green, DECISION=purple |
| Phase | `phase` — dim grey |
| Message | `message` — truncated to fit |

Scrollable panel with thin custom scrollbar.

### 5. Footer Bar (full width)

- Left: `Auto-refreshes every 30s · All times Europe/London`
- Right: `trader-v2 @ {git short hash}`

Git hash: read from `git rev-parse --short HEAD` at boot time (cache it, don't shell out per request).

## Implementation

### Files to modify

- `src/monitoring/status-page.ts` — **rewrite** with new HTML builder
- `src/monitoring/health.ts` — **extend** `HealthData` interface with new fields, or create a separate `getDashboardData()` function

### New data function

Create `getDashboardData()` in `health.ts` (or a new `dashboard-data.ts`) that gathers all data in a single function:

```typescript
interface DashboardData {
  // Existing
  status: "ok" | "degraded" | "error";
  uptime: number;
  timestamp: string;
  paused: boolean;
  ibkrConnected: boolean;
  ibkrAccount: string | null;
  
  // KPIs
  dailyPnl: number;
  weeklyPnl: number;
  dailyPnlLimit: number;
  weeklyPnlLimit: number;
  openPositionCount: number;
  tradesToday: number;
  apiSpendToday: number;
  apiBudget: number;
  lastQuoteTime: string | null;
  
  // Strategy pipeline
  strategies: Array<{
    id: number;
    name: string;
    status: string;
    winRate: number | null;
    sharpeRatio: number | null;
    tradeCount: number;
    universe: string[];
  }>;
  
  // Live positions
  positions: Array<{
    symbol: string;
    exchange: string;
    quantity: number;
    avgCost: number;
    unrealizedPnl: number | null;
    strategyId: number | null;
  }>;
  
  // Cron schedule
  cronJobs: Array<{
    name: string;
    nextRun: string;
    nextRunIn: string;
    lastStatus: "ok" | "error" | "never";
  }>;
  
  // Activity log
  recentLogs: Array<{
    time: string;
    level: string;
    phase: string | null;
    message: string;
  }>;
  
  // Meta
  gitHash: string;
}
```

### Cron next-run computation

Write a helper `getNextCronOccurrence(cronExpr: string, timezone: string): Date` that computes the next run from a cron expression. Use `cron-parser` package (already available via `node-cron` dependency) or write a minimal parser for the patterns used (they're all simple — no complex ranges).

Alternatively, hardcode the schedule as a static map of `JobName → { cron, description }` and compute next runs from that.

### Performance

All queries are against SQLite (single file, no network). Dashboard data gathering should take <50ms. No caching needed — the 30s auto-refresh is sufficient rate limiting.

### Auth

Keep existing basic auth on `GET /`. The `/health` endpoint remains unauthenticated (returns JSON, not HTML).

### API endpoint

Expose `GET /api/dashboard` returning the full `DashboardData` as JSON (behind auth). This lets you `curl` for machine-readable data without scraping HTML.

## What's NOT in scope

- WebSocket live updates (auto-refresh is fine for a monitoring dashboard)
- Charts or sparklines (adds complexity for minimal value at this stage)
- Mobile-responsive layout (this is a desktop monitoring tool)
- Editing strategies or placing trades from the UI
