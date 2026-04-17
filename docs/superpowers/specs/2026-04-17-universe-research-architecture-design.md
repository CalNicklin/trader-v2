# Universe Research Architecture — Design Spec

**Date:** 2026-04-17
**Status:** Draft for review
**Motivation:** Today (2026-04-17) the system produced 0 trades despite 20+ tradeable news classifications and 5+ high-confidence research hits, because every one of those signals had to land on a symbol in a hand-picked 25-symbol seed universe. This spec replaces the static seed universe with a layered, research-driven universe architecture that mirrors how real trading desks discover and trade stocks.

## The problem in one sentence

We are news readers, not traders — the system only trades symbols we already decided to watch, instead of letting research tell us which symbols to watch.

## Current state

- Each strategy has a static `universe` JSON array baked into its seed definition (~25 symbols, heavily US tech mega-cap weighted plus a hand-picked LSE/AIM set).
- The news classifier only considers headlines about those pre-seeded symbols.
- The research agent can inject new symbols via `universeCache` with a 24h TTL, but only after news already named them.
- There is no mechanism for the system to discover a symbol it doesn't already know about.
- There is no point-in-time record of what the universe *was* on any given past day (problem for learning-loop backtests — survivorship bias).
- There is no explicit demotion pathway — injected symbols just TTL out silently.
- All four tiers that real desks maintain (universe → watchlist → candidates → positions) are collapsed into one 25-symbol list.

## Target architecture — four tiers

The industry-standard funnel, adapted to our stack:

| Tier | Size | Refresh | What lives here | Where defined |
|---|---|---|---|---|
| 1. Investable Universe | ~800 | Weekly (Mon 03:00 UTC) | Hard eligibility: liquid, priced, listed, not excluded | New `investable_universe` table |
| 2. Active Watchlist | 40–150 | Daily (22:45 UTC post-close) | Catalyst-promoted. LLM research deep-dives happen here | New `watchlist` table |
| 3. Candidates | 5–20 | Intraday (per-eval cycle) | Strategies evaluating signals right now | Ephemeral in evaluator |
| 4. Positions | 10–40 | Live | Sized, risk-managed | Existing `paper_positions` / broker |

The existing strategy evaluator, graduation gate, risk guardrails, and learning loop all consume Tier 2 (watchlist) instead of the old per-strategy universe. Everything downstream of "what set of symbols do we evaluate" is unchanged.

## Tier 1 — Investable Universe

**Purpose:** answer "what *can* we trade" with hard rules. No alpha, no LLM, no per-strategy variation. This layer is cheap and wide.

### Source composition

- **US:** Russell 1000 membership (proxy via FMP `/v3/russell-1000-constituent` or cached index file)
- **UK:** FTSE 350 + AIM All-Share constituents (FMP `/v3/symbol/FTSE`, `/v3/symbol/AIM` or hand-curated weekly-refreshed list). After the $5M ADV liquidity filter the effective AIM count will likely be ~30–80 names — AIM is fraud-prone and thin, but the liquidity floor handles that. The existing seed universe already trades some AIM names (GAW, FDEV, TET, JET2, BOWL), so this is continuity rather than expansion.
- **Always included if held:** existing strategies' open positions (to avoid orphaning active trades during refresh)

### Eligibility filters (applied at refresh time)

All must pass for inclusion:

- `avg_dollar_volume_usd >= 5_000_000` (20-day median dollar volume)
- `price >= 5` (US) / `>= 100p` (UK) — microstructure floor
- `free_float_usd >= 100_000_000`
- `top_of_book_spread_bps <= 25` (live-sampled, with fallback to historical median)
- Listing age `>= 90 trading days` (post-IPO seasoning)
- Primary listing on NYSE/NASDAQ/LSE (no OTC, no pink sheets)
- NOT currently under SEC investigation / halt
- NOT a leveraged/inverse ETF
- NOT a recent SPAC merger within 90 days
- NOT a name the learning loop has flagged `exclude_from_universe` within 60 days

### Refresh cadence

- Weekly rules-based rebuild (Monday 03:00 UTC, before pre-market).
- Daily delta check: symbols breaching any filter get auto-demoted immediately (e.g. halted, bankruptcy news).
- Symbols with open positions are **never** removed — they stay until position closes.

### Point-in-time snapshots

Every daily delta writes to `universe_snapshots` (date, symbol, reason_for_change). Enables:
- Survivorship-bias-free backtests by the learning loop.
- "What was our universe on 2026-03-15?" forensics.

## Tier 2 — Active Watchlist

**Purpose:** answer "what *should* we research and potentially trade this week" — catalyst-driven, LLM-curated, hygiene-maintained.

### Promotion triggers

A name enters the watchlist when **any** of the following fire:

1. **News catalyst:** classifier marks headline `tradeable=true AND urgency>=medium AND symbol in investable_universe`
2. **Research agent promotion:** existing research agent path, confidence `>= 0.75`
3. **Earnings window:** name reports within next 5 trading days (via FMP `/v3/earning_calendar`)
4. **Unusual volume:** `volume_ratio >= 3.0` over 20-day avg, same session (via existing quotes_cache)
5. **Missed-opportunity feedback:** learning loop surfaces a name repeatedly — three missed-opportunity insights with confidence `>= 0.8` in 14 days → auto-promote

Deferred to a follow-up (kept out of v1 scope for minimum cost / engineering surface):

- **Insider buy (Form 4):** high alpha but requires EDGAR parsing and new data pipeline. Defer to a focused follow-up once the four-tier architecture is proven.
- **8-K filings:** same reasoning — defer.
- **Sector rotation:** requires a daily sector-RS scanner; defer to a later enhancement.

Rationale: five triggers (news, research, earnings, volume, feedback) already cover the two largest alpha-density sources identified in the research memo (news catalysts, earnings calendar) plus the existing research-agent and learning-loop feedback. Shipping without SEC data keeps v1 dependency-free and costs unchanged.

### Research enrichment (Opus/Sonnet)

Within 1 hour of promotion, an LLM research pass enriches each new watchlist entry with:
- Catalyst summary (1-2 sentences)
- Directional bias (long / short / ambiguous)
- Expected move horizon (intraday / days / weeks)
- Correlated names (for basket-cap purposes)

Stored in `watchlist.research_payload` (JSON). Cost model: ~1 Opus call per promotion, estimated 20-60/day = $0.40–$1.20/day.

### Demotion / removal

A watchlist entry is demoted when **any**:

- No promotion trigger has re-fired in 72 hours (staleness)
- Catalyst has resolved (earnings done, M&A closed, 8-K fully priced in — LLM-evaluated)
- Volume collapse: `avg_dollar_volume_usd < 5M` for 3 consecutive sessions
- Name is removed from the investable universe (delisted, halted, etc.)
- Learning loop flags `demote_watchlist` for a specific name
- Position closed and zero open signal activity for 24h (respects open positions)

### Watchlist cap

Soft cap at 150 entries. When exceeded, demote the lowest-ranked by catalyst-recency + historical signal response composite score. Never exceed 300 (hard cap — above this, infrastructure strains).

## Tier 3 — Candidates (evaluator)

**Unchanged from current design**, except for the source of the per-strategy universe.

### Strategy → watchlist mapping

Each strategy gains a `watchlist_filter` spec in place of the current static `universe` array:

```json
{
  "watchlist_filter": {
    "exchanges": ["NASDAQ", "NYSE"],
    "market_cap_min": 2000000000,
    "catalyst_types": ["news", "earnings", "insider_buy"],
    "directional_bias": ["long", "ambiguous"],
    "exclude_sectors": []
  }
}
```

At evaluator time, the strategy reads the current watchlist filtered by its spec. This is the list of symbols it evaluates each tick.

### Migration path for existing seeds

Each existing seed strategy's static universe becomes a `watchlist_filter` that approximately reproduces the current coverage, so behaviour is unchanged day-one. Example:

```
news_sentiment_mr_v1 old universe: 25 hand-picked names
news_sentiment_mr_v1 new filter:   exchanges=[NASDAQ, NYSE, LSE], catalyst_types=[news]
```

Day-one: strategy sees roughly the same 15-30 names (those currently carrying catalysts). Day-thirty: it sees whatever the market surfaces via catalysts on the full investable universe.

## Tier 4 — Positions

**Unchanged.** The existing `paper_positions` table, risk guardrails, basket cap, kill floor, circuit breaker, LSE cooldown all apply as-is.

## Data model changes

New tables:

### `investable_universe`

```
id                integer PK
symbol            text
exchange          text
market_cap_usd    real
avg_dollar_vol    real
price             real
free_float_usd    real
spread_bps        real
inclusion_date    text (ISO)
last_refreshed    text (ISO)
active            integer (boolean)
UNIQUE (symbol, exchange)
```

### `watchlist`

```
id                integer PK
symbol            text
exchange          text
promoted_at       text (ISO)
promotion_reason  text enum: news | research | earnings | insider | volume | rotation | feedback
catalyst_summary  text (LLM-generated)
directional_bias  text enum: long | short | ambiguous
horizon           text enum: intraday | days | weeks
research_payload  text (JSON)
expires_at        text (ISO)
demoted_at        text (ISO, nullable)
demotion_reason   text (nullable)
UNIQUE (symbol, exchange) WHERE demoted_at IS NULL
```

### `universe_snapshots`

```
id                integer PK
snapshot_date     text (ISO, date only)
symbol            text
exchange          text
action            text enum: added | removed | unchanged
reason            text
INDEX (snapshot_date)
```

### `catalyst_events`

Consolidated catalyst log for watchlist promotion triggers (supersedes ad-hoc logging):

```
id                integer PK
symbol            text
exchange          text
event_type        text enum: news | earnings | insider_buy | volume | filing_8k | ...
source            text (URL or system)
payload           text (JSON — event-specific)
fired_at          text (ISO)
led_to_promotion  integer (boolean)
```

### Strategy schema change

Add `watchlist_filter` TEXT column (JSON) to `strategies`. Keep existing `universe` column temporarily for backwards-compatibility during migration; drop after 30 days of watchlist-filter-only operation.

## Data sources

Already wired:
- **FMP:** `/v3/russell-1000-constituent`, `/v3/symbol/FTSE`, `/v3/symbol/AIM`, `/v3/earning_calendar`, `/v3/stock-screener`, `/v3/quote/<symbol>` for spread sampling
- **IBKR:** market-data snapshots (fallback / confirmation)
- **News classifier:** existing pipeline
- **Research agent:** existing Opus/Sonnet path

No new paid dependencies in v1. SEC filings (Form 4, 8-K) are deferred to a follow-up iteration to minimize v1 cost and scope.

## Component changes

| Component | Change |
|---|---|
| `src/strategy/seed.ts` | Each seed grows a `watchlist_filter`; static `universe` arrays become compatibility fallbacks |
| `src/strategy/evaluator.ts` | `getUniverseForStrategy()` now queries watchlist filtered by `watchlist_filter`, not `strategy.universe` |
| `src/strategy/universe.ts` | New module: builds and maintains investable_universe; promotion/demotion logic for watchlist |
| `src/news/classifier.ts` | Classifier widens symbol extraction to full investable_universe, not the legacy 25-list |
| `src/news/research-agent.ts` | Becomes the enrichment engine for watchlist promotions (not the promotion trigger itself) |
| `src/scheduler/cron.ts` | Three new jobs: weekly universe refresh (Mon 03:00), daily watchlist curation (22:45), hourly catalyst sweep (during sessions) |
| `src/learning/*` | Missed-opportunity tracker writes back to `catalyst_events` for the `feedback` promotion trigger |

## Rollout strategy — additive, reversible

This is a substantial change and ships in steps:

**Step 1 — Build investable_universe, no behaviour change**
Populate the table, snapshot daily, surface in dashboard. Nothing reads from it yet.

**Step 2 — Build watchlist, no behaviour change**
Populate from news + earnings + research-agent promotions. Strategies still read their static universes.

**Step 3 — Migrate strategies one at a time**
`news_sentiment_mr_v1` first (smallest blast radius, already news-gated). Run with `watchlist_filter` for 10 trading days; compare trade count and P&L against baseline. Roll back via env flag if regressed.

**Step 4 — Migrate remaining strategies**
`earnings_drift_v1` and `earnings_drift_aggressive_v1`. These gain earnings-calendar auto-promotion which is the catalyst they were designed for.

**Step 5 — Retire static universes**
After 30 days of stable watchlist operation, drop the legacy `universe` column.

Each step is a separate PR. Steps 1–2 are pure additive infrastructure. Step 3 onward has an env kill-switch (`USE_WATCHLIST=false`) to fall back to static universes immediately.

## Cost model

Estimated monthly LLM cost delta:

- **Watchlist research enrichment** (Opus): 20–60 promotions/day × ~1500 tokens × $15/M output ≈ **$0.40–$1.20/day** = $12–$36/month
- **Catalyst sweep context (Sonnet):** negligible — we already classify news; the promotion check is pure code
- **Rules-based universe refresh:** zero LLM

Estimated API cost delta:

- **FMP:** adds `/earning_calendar` daily, `/russell-1000-constituent` + `/symbol/AIM` weekly — all within free/existing tier
- **IBKR spread sampling:** no new cost, uses existing subscription
- **SEC filings:** deferred to follow-up; zero v1 cost

Net estimate: **$12–$36/month** incremental LLM cost only. No new paid data feeds. Subsumes Wave 2 proposal #10 (AI supply-chain universe-add) entirely.

## How this subsumes open backlog

- **Wave 2 #10** (AI supply-chain universe slice) — no longer needed; those names are in Russell 1000.
- **Wave 2 #1** (catalyst-veto on shorts) — becomes much stronger with catalyst events already logged.
- **Wave 2 #9** (catalyst-momentum seed) — trivially easy to build once the watchlist exists with catalyst metadata.

## Non-goals for this spec

Out of scope — may come later but not in this design:

- Option flow ingestion (unusual options activity as a promotion trigger)
- Short-interest change tracking (requires paid data)
- Sector-rotation scanner as an explicit promotion trigger
- Cross-asset signals (bond/equity divergence, VIX)
- Replacing seed strategies themselves (we keep the existing strategy class; only the universe selection changes)
- Live-trading flag changes — this is paper-first; live flip follows existing gating

## Decisions locked in

- **SEC filings data source:** deferred to a post-v1 iteration. v1 ships without Form 4 or 8-K — news, earnings, volume, research, and feedback triggers already cover the two highest-alpha catalyst classes.
- **UK universe:** include both FTSE 350 and AIM All-Share. The $5M ADV filter handles the AIM liquidity problem mechanically; expected effective AIM count after filtering is ~30–80 names.
- **Migration order:** `news_sentiment_mr_v1` first (smallest blast radius, already news-gated).

## Still-open questions

- **Watchlist cap:** 150 soft / 300 hard — too conservative for v1? (Default: 150/300. Easy to raise later based on observed behaviour.)
- **Default `watchlist_filter` for mutation-spawned children:** inherit parent's filter verbatim, or start with a permissive default? (Default recommendation: inherit; evolution can mutate it.)

Both can be resolved in the implementation plan — not blocking.

## Success criteria (30 days after Step 4 migration complete)

- **Trade count** ≥ 3× baseline (today = ~5–10 trades/week, target ≥ 15–30/week) — primary volume target
- **Per-trade Sharpe** ≥ current baseline ± 20% — we don't want volume-for-volume's sake
- **Watchlist hit rate** ≥ 30% — of names promoted to watchlist, at least 30% should produce a traded signal within TTL
- **Coverage breadth:** ≥ 80 unique symbols traded in the 30-day window (vs. ~8–12 on the old universe)
- **Survivorship-bias check:** learning loop's next insight review uses `universe_snapshots` for point-in-time evaluation
