# Dashboard Subsystem Tabs

Add four new tabs to the monitoring dashboard to surface subsystem activity that is already stored in the database but not currently visible.

## Tabs

The existing dashboard content becomes the **Overview** tab. Four new tabs are added:

| Tab | Data Source | Layout |
|-----|-------------|--------|
| News Pipeline | `news_events` | Summary stats + scrollable article log |
| Guardian | `risk_state` + `agent_logs` (phase=risk_guardian) | State cards + check history log |
| Learning Loop | `trade_insights` | Summary stats + insight card log |
| Trades | `paper_trades` + `strategies` | Structured table + summary stats |

## Approach

Extend the existing single-page renderer. A `?tab=<name>` query parameter selects the active tab. The shared chrome (status bar, tab bar, footer, CSS) renders once; only the body content changes per tab.

### Files Changed

- `src/monitoring/dashboard-data.ts` — add data-fetching functions per tab
- `src/monitoring/status-page.ts` — add tab bar to shared shell, add tab content renderers
- `src/monitoring/server.ts` — pass `tab` query param through; redirect pause/resume back to current tab

No new files. No new dependencies.

## Tab Bar

Sits between the status bar and content area. Each tab is an `<a href="/?tab=name">` link. Active tab gets amber underline + text color. The `<meta http-equiv="refresh">` tag preserves the current tab: `content="30;url=/?tab=news"`.

Valid tab values: `overview` (default), `news`, `guardian`, `learning`, `trades`.

## Tab: News Pipeline (`?tab=news`)

### Data: `getNewsPipelineData()`

Queries `news_events` table.

**Summary stats (last 24h):**
- Total stored (count all rows — these are articles that passed dedup)
- Classified (count rows with non-null sentiment)
- Tradeable + high-urgency (count where `tradeable = true AND urgency = 'high'`)
- Average sentiment (avg of `sentiment` column where non-null)

**Article log:**
- Last 50 rows ordered by `created_at` desc
- Fields: time (from `created_at`), symbols (parsed from JSON), headline, sentiment, confidence, urgency, event type, tradeable flag

### Rendering

Four stat cards across the top (same style as existing KPI strip). Below, a scrollable table with columns: Time, Symbol, Headline, Sentiment, Urgency. Sentiment is color-coded green (positive) / red (negative). Urgency HIGH is amber, MED is muted, LOW is dim.

## Tab: Guardian (`?tab=guardian`)

### Data: `getGuardianData()`

Queries `risk_state` table for current flags + `agent_logs` for history.

**Current state:**
- Circuit breaker: read `risk_state` key `circuit_breaker_tripped` (true/false) + `peak_balance` and `account_balance` to compute drawdown percentage
- Daily halt: read `daily_halt_active` + `daily_pnl` vs `DAILY_LOSS_HALT_PCT`
- Weekly drawdown: read `weekly_drawdown_active` + `weekly_pnl` vs `WEEKLY_DRAWDOWN_LIMIT_PCT`

**Check history:**
- Last 30 rows from `agent_logs` where `phase = 'risk_guardian'`, ordered by `created_at` desc
- Fields: time, level, message. Parse `data` JSON column for threshold values if present.

### Rendering

Three state cards across the top, each with:
- Status indicator dot (green = clear, red = active)
- Current value vs threshold (e.g., "2.1% / 10%")
- Border color reflects state (green border = clear, red border = active)

Below, a scrollable log of guardian checks. Rows showing warnings are highlighted amber. Rows showing trips are highlighted red.

## Tab: Learning Loop (`?tab=learning`)

### Data: `getLearningLoopData()`

Queries `trade_insights` table.

**Summary stats (last 7 days):**
- Total insights (count rows)
- Led to improvement (count where `led_to_improvement = true`)
- Patterns found (count where `insight_type = 'pattern_analysis'`)

**Insight log:**
- Last 30 rows ordered by `created_at` desc
- Fields: created_at, insight_type, observation, suggested_action (parsed JSON), confidence, tags (parsed JSON), led_to_improvement

### Rendering

Three stat cards across the top. Below, a card-style list where each insight shows:
- Type badge (trade_review = blue, pattern_analysis = purple, graduation = green)
- Observation text
- Confidence score + tags
- Timestamp
- Led-to-improvement checkmark if true

## Tab: Trades (`?tab=trades`)

### Data: `getTradeActivityData()`

Queries `paper_trades` joined with `strategies` for strategy name.

**Trade table:**
- Last 50 trades ordered by `created_at` desc
- Fields: time, symbol, side (BUY/SELL), price, pnl (null if still open), strategy name, signal_type, reasoning (truncated to 80 chars)

**Summary stats (today):**
- Trade count today
- Win rate (trades with `pnl > 0` / total trades with non-null `pnl`, today)
- Average winner P&L (avg of `pnl` where `pnl > 0`, today)
- Average loser P&L (avg of `pnl` where `pnl < 0`, today)

### Rendering

Scrollable table at top with columns: Time, Symbol, Side, Price, P&L, Strategy, Signal, Reason. Side is color-coded (BUY = green, SELL = red). P&L is color-coded (positive = green, negative = red).

Four summary stat cards at the bottom.

## Shared CSS

New styles needed:
- `.tab-bar` — flex container for tab links
- `.tab-link` — individual tab, uppercase, letter-spaced
- `.tab-link.active` — amber text + bottom border
- `.stat-cards` — grid container for summary stat cards (reuses existing KPI styling)
- `.insight-card` — card style for learning loop entries
- `.type-badge` — colored label for insight types

All new styles follow the existing dark terminal aesthetic: `#050505` background, `#0a0a0a` panels, `#1a1a1a` borders, JetBrains Mono font, amber/green/red accent colors.

## Tab Refresh Behavior

The `<meta http-equiv="refresh" content="30">` tag becomes `<meta http-equiv="refresh" content="30;url=/?tab=${currentTab}">`. This preserves tab selection across auto-refreshes.

Pause/resume form actions redirect back to `/?tab=${currentTab}` instead of just `/`.

## Data Interface Types

```typescript
interface NewsPipelineData {
  totalArticles24h: number;
  classifiedCount: number;
  tradeableHighUrgency: number;
  avgSentiment: number;
  recentArticles: Array<{
    time: string;
    symbols: string[];
    headline: string;
    sentiment: number | null;
    confidence: number | null;
    urgency: string | null;
    eventType: string | null;
    tradeable: boolean | null;
  }>;
}

interface GuardianData {
  circuitBreaker: { active: boolean; drawdownPct: number; limitPct: number };
  dailyHalt: { active: boolean; lossPct: number; limitPct: number };
  weeklyDrawdown: { active: boolean; lossPct: number; limitPct: number };
  peakBalance: number;
  accountBalance: number;
  checkHistory: Array<{
    time: string;
    level: string;
    message: string;
  }>;
}

interface LearningLoopData {
  insightsCount7d: number;
  ledToImprovement: number;
  patternsFound: number;
  recentInsights: Array<{
    time: string;
    insightType: string;
    observation: string;
    suggestedAction: string | null;
    confidence: number | null;
    tags: string[];
    ledToImprovement: boolean | null;
  }>;
}

interface TradeActivityData {
  trades: Array<{
    time: string;
    symbol: string;
    exchange: string;
    side: string;
    price: number;
    pnl: number | null;
    strategyName: string;
    signalType: string;
    reasoning: string | null;
  }>;
  tradesToday: number;
  winRateToday: number | null;
  avgWinner: number | null;
  avgLoser: number | null;
}
```
