# Universe Step 2 — Active Watchlist Design Spec

**Date:** 2026-04-17
**Status:** Draft for review
**Parent:** `docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md`
**Prerequisite:** Step 1a (PR #18) merged 2026-04-17

## Goal

Build Tier 2 of the four-tier universe architecture: a catalyst-promoted `watchlist` table with LLM research enrichment, demotion rules, and `/health` surface. Step 2 is purely additive — no strategy consumes the watchlist yet. Step 3 is the first consumer.

## Scope

### In scope

- New tables: `watchlist`, `catalyst_events`
- Five promotion triggers wired end-to-end: news, research, earnings, volume, feedback
- Async LLM enrichment via a dedicated cron job (not inline with promotion)
- Six demotion rules from the parent spec
- Soft-cap eviction at 150 entries, hard cap 300
- `/health` watchlist section with operator-visible state
- Eval suite for enrichment prompt quality

### Explicitly out of scope

- `watchlist_filter` column on `strategies` — **deferred to Step 3**, shaped by the first real consumer
- Any strategy migration — deferred to Steps 3 and 4
- SEC filings (Form 4, 8-K) — deferred per parent spec
- Sector-rotation trigger — deferred per parent spec

## Five open questions — resolutions

| Question | Resolution |
|---|---|
| Which triggers in v1? | All five (news, research, earnings, volume, feedback) — parent spec lock-in |
| Enrichment sync or async? | **Async cron** — decouples promotion latency from Opus latency, matches "within 1 hour" SLA, clean failure semantics |
| Ship `watchlist_filter` on strategies? | **Deferred to Step 3** — YAGNI, lets the first real consumer shape the column |
| Surface on `/health`? | **Yes, full section** — total active, by reason, unenriched count, oldest-age, last-sweep |
| How to test LLM-enrichment affordably? | **Eval suite + pure-function unit tests** — satisfies CLAUDE.md eval-driven-development requirement; API budget not a concern for quality testing |

## Architecture

Three layers:

### Layer 1 — Catalyst capture

Five writers push into a shared `catalyst_events` table. Each writer lives where its data source already lives:

| Trigger | Writer location | When it fires |
|---|---|---|
| News | `src/news/classifier.ts` | After tradeable classification AND symbol ∈ investable_universe |
| Research | `src/news/research-agent.ts` | When agent confidence ≥ 0.75 |
| Earnings | `src/scheduler/earnings-catalyst-job.ts` | Daily 22:45 UTC from FMP `/v3/earning_calendar` — names reporting in next 5 trading days |
| Volume | `src/scheduler/volume-catalyst-job.ts` | At session boundaries — `volume_ratio ≥ 3.0` vs 20-day avg |
| Feedback | `src/learning/pattern-analysis.ts` | 3+ missed-opportunity insights with confidence ≥ 0.8 in 14 days for the same name |

Each writer does two things: insert a `catalyst_events` row, and call `promoteToWatchlist(symbol, exchange, reason, payload, ttl)`. The catalyst event's `led_to_promotion` flag is set `true` when promotion succeeds.

### Layer 2 — Watchlist state machine

New module `src/watchlist/` owns all state transitions. Every promotion is idempotent: a re-firing catalyst on an already-active symbol updates `last_catalyst_at` and extends `expires_at`, merging the new reason into `promotion_reasons`. Never creates a duplicate row.

### Layer 3 — Enrichment

A new `watchlist-enrich-job.ts` cron picks up unenriched rows every 15 minutes during active sessions (+ one post-close sweep), batches up to 10 per run, calls Opus, writes `research_payload`, `directional_bias`, `horizon`, `catalyst_summary`. Failures leave the row unenriched for retry.

## Schema

### New table: `watchlist`

```
id                   integer PK
symbol               text NOT NULL
exchange             text NOT NULL
promoted_at          text NOT NULL (ISO)
last_catalyst_at     text NOT NULL (ISO)
promotion_reasons    text NOT NULL (comma-joined union of triggers)
catalyst_summary     text (nullable, LLM-filled)
directional_bias     text enum: long|short|ambiguous (nullable)
horizon              text enum: intraday|days|weeks (nullable)
research_payload     text (JSON, nullable)
enriched_at          text (nullable, ISO)
enrichment_failed_at text (nullable, ISO)
expires_at           text NOT NULL (ISO)
demoted_at           text (nullable, ISO)
demotion_reason      text (nullable)

UNIQUE INDEX (symbol, exchange) WHERE demoted_at IS NULL
INDEX (demoted_at)
INDEX (enriched_at) WHERE demoted_at IS NULL
```

Refinements over parent spec:

- `last_catalyst_at` — added for staleness demotion + soft-cap ranking
- `promotion_reasons` (plural, comma-joined) — replaces parent spec's singular `promotion_reason` because five triggers can fire concurrently
- `enrichment_failed_at` — permanent-failure marker; demotion rule flags this for eviction after 48h
- Partial unique index on `(symbol, exchange) WHERE demoted_at IS NULL` — matches parent spec intent; allows historical demoted rows to survive

### New table: `catalyst_events`

```
id                integer PK
symbol            text NOT NULL
exchange          text NOT NULL
event_type        text (enum: news|research|earnings|volume|feedback|insider_buy|filing_8k|rotation)
source            text (URL / news event id / module name)
payload           text (JSON, event-specific)
fired_at          text NOT NULL (ISO)
led_to_promotion  integer NOT NULL default 0 (boolean)

INDEX (symbol, exchange, fired_at)
INDEX (event_type, fired_at)
```

Enum accepts deferred event types (`insider_buy`, `filing_8k`, `rotation`) so a future follow-up doesn't need a migration to add them. Step 2 writes only the five v1 event types.

### Not in this migration

- No changes to `strategies` table (`watchlist_filter` deferred to Step 3)
- No changes to `investable_universe` or `universe_snapshots`

## Components

### New module `src/watchlist/`

| File | Exports |
|---|---|
| `constants.ts` | Thresholds (see table below) |
| `promote.ts` | `promoteToWatchlist(input): Promise<PromoteResult>` — idempotent upsert |
| `demote.ts` | `runDemotionSweep(now): Promise<DemotionResult>` — six rules + cap eviction |
| `filters.ts` | `rankForCapEviction(rows): RankedRow[]` — catalyst-recency × signal-response composite |
| `repo.ts` | Reads: `getActiveWatchlist`, `getUnenrichedRows(limit)`, `getWatchlistByExchange`, `countActive` |
| `catalyst-events.ts` | `writeCatalystEvent(evt)` + `markLedToPromotion(id)` |
| `enrich.ts` | `buildEnrichmentPrompt(row, recentEvents) → string`<br/>`parseEnrichmentResponse(text) → EnrichmentPayload \| ParseError`<br/>`enrichOne(row, llm): Promise<EnrichResult>` |

### Constants

| Constant | Value | Source |
|---|---|---|
| `VOLUME_TRIGGER_RATIO` | 3.0 | Parent spec |
| `EARNINGS_LOOKAHEAD_DAYS` | 5 | Parent spec |
| `RESEARCH_MIN_CONFIDENCE` | 0.75 | Parent spec |
| `FEEDBACK_INSIGHT_THRESHOLD` | 3 | Parent spec |
| `FEEDBACK_INSIGHT_WINDOW_DAYS` | 14 | Parent spec |
| `FEEDBACK_MIN_CONFIDENCE` | 0.8 | Parent spec |
| `WATCHLIST_CAP_SOFT` | 150 | Parent spec |
| `WATCHLIST_CAP_HARD` | 300 | Parent spec |
| `DEFAULT_PROMOTION_TTL_HOURS` | 72 | Parent spec (staleness rule = 72h) |
| `ENRICH_BATCH_SIZE` | 10 | Matches Opus batch norms + budget guard headroom |
| `ENRICHMENT_RETRY_HOURS` | 24 | Time before marking `enrichment_failed_at` |
| `ENRICHMENT_DEMOTION_HOURS` | 48 | Time after `enrichment_failed_at` before demotion |

### Modified existing files

| File | Change |
|---|---|
| `src/news/classifier.ts` | After tradeable classification, if symbol ∈ investable_universe → `writeCatalystEvent` + `promoteToWatchlist(reason="news")` |
| `src/news/research-agent.ts` | When confidence ≥ 0.75 → write catalyst event + promote with `reason="research"` |
| `src/learning/pattern-analysis.ts` | When 3× ≥0.8 missed-opportunity insights fire in 14d window → promote with `reason="feedback"` |
| `src/monitoring/health.ts` (or equivalent) | Add `watchlist` section to `/health` JSON |

### New scheduler jobs

| File | Cron (UTC) | Purpose |
|---|---|---|
| `src/scheduler/earnings-catalyst-job.ts` | `45 22 * * 1-5` | Read FMP earning_calendar, promote names reporting in next 5 sessions |
| `src/scheduler/volume-catalyst-job.ts` | 4 entries: `5 8 * * 1-5`, `35 14 * * 1-5`, `35 16 * * 1-5`, `0 18 * * 1-5` | Scan quotes_cache for volume_ratio ≥ 3.0, session-scoped |
| `src/scheduler/watchlist-enrich-job.ts` | `*/15 8-20 * * 1-5` + `50 22 * * 1-5` | Batch enrich up to 10 unenriched rows per run |
| `src/scheduler/watchlist-demote-job.ts` | `55 22 * * 1-5` | Run demotion sweep after enrichment completes |

All four jobs registered in `src/scheduler/cron.ts` and mirrored in `src/monitoring/cron-schedule.ts` per CLAUDE.md.

### Scheduling sequence at post-close

Order matters — demotion rule "catalyst resolved" depends on enrichment having run:

```
22:45 earnings-catalyst-job
22:50 watchlist-enrich-job (post-close sweep)
22:55 watchlist-demote-job
```

### Job lock categories

- `earnings` — earnings-catalyst-job
- `catalyst_us` / `catalyst_uk` — volume-catalyst-job (per-exchange, parallel)
- `enrichment` — watchlist-enrich-job
- `demotion` — watchlist-demote-job

Splitting volume job by exchange lock follows the existing UK/US parallelism pattern in `src/scheduler/locks.ts`.

## Data flow

### Promotion flow (example: news catalyst)

```
Finnhub headline → news_event row
  → classifier.classifyHeadline() returns { tradeable: true, urgency: medium, ... }
  → classifier.ts: isInInvestableUniverse(symbol, exchange)? if false, skip
  → classifier.ts: writeCatalystEvent({ symbol, exchange, event_type: "news",
                                         source: news_event_id, payload, fired_at })
  → classifier.ts: promoteToWatchlist({ symbol, exchange, reason: "news",
                                         payload: { headline, urgency }, ttl: 72h })
  → promote.ts:
      SELECT existing row WHERE symbol+exchange AND demoted_at IS NULL
      if none:  INSERT (enriched_at = null, promoted_at = now, expires_at = now + 72h)
      if exists: UPDATE last_catalyst_at = now,
                        expires_at = max(current, now + 72h),
                        promotion_reasons = merge(existing, new)
  → catalyst-events.markLedToPromotion(eventId)
```

Promotion is synchronous (DB-only). Enrichment happens async.

### Enrichment flow (async cron)

```
watchlist-enrich-job fires
  → budgetGuard.canAffordCall("opus", estimatedTokens * batchSize)? if false, skip
  → repo.getUnenrichedRows(limit=10) → rows
  → for each row:
      recentEvents = last N catalyst_events for (symbol, exchange) within TTL
      prompt  = buildEnrichmentPrompt(row, recentEvents)
      text    = await opus.complete(prompt)         [pure fn boundary — injectable]
      parsed  = parseEnrichmentResponse(text)
      if ok:   UPDATE watchlist SET research_payload, directional_bias, horizon,
                                     catalyst_summary, enriched_at = now
      else:    log.warn, row.enrichment_retries++, row stays unenriched
      if retry_window_exceeded: SET enrichment_failed_at = now, log.error
  → emit { enriched, failed, skipped_due_to_budget }
```

### Demotion flow (daily post-close)

Per-row sweep applies six rules in order. First matching rule wins:

1. **Staleness** — `last_catalyst_at` older than 72h → `demotion_reason = "stale"`
2. **Catalyst resolved** — LLM flagged `status: resolved` in research_payload → `"resolved"`
3. **Volume collapse** — 3 consecutive sessions of `avg_dollar_volume < $5M` → `"volume_collapse"`
4. **Universe removal** — symbol no longer in active `investable_universe` → `"universe_removed"`
5. **Learning-loop demote** — pattern-analysis wrote a `demote_watchlist` flag → `"feedback_demote"`
6. **Position-closed + idle** — 24h after position close with no new signal activity → `"position_closed"`
7. **Enrichment permanently failed** — `enrichment_failed_at` > 48h ago → `"enrichment_failed"`

**Never-demote exception:** symbol with open position in `paper_positions` or broker → skipped entirely, regardless of any rule match. Parent spec hard rule.

**Cap eviction:** after per-row sweep, if active count > `WATCHLIST_CAP_SOFT` (150), rank remaining actives by `rankForCapEviction` (catalyst recency × signal response composite); demote bottom rows with reason `"cap_eviction"` until count ≤ 150. Hard cap 300 is a circuit-breaker — if hit, log.error and demote aggressively.

## Error handling

| Failure | Handling |
|---|---|
| Opus call fails (network, 5xx) | Row stays unenriched, retry next tick |
| Opus returns malformed JSON | `parseEnrichmentResponse` → ParseError; log.warn with response snippet; retry |
| Validation fails (bad enum, missing field) | Same as malformed |
| Enrichment fails > `ENRICHMENT_RETRY_HOURS` (24h) | Set `enrichment_failed_at`; demotion job evicts after 48h more |
| Daily Opus budget exhausted | Skip entire batch, log.warn, resume next day. Do NOT demote unenriched rows. |
| FMP earnings-calendar fetch fails | Log.warn, skip day; natural fallback is news-catalyst path when the event actually hits |
| Volume-job query returns zero candidates | Normal no-op |
| Promotion called with symbol ∉ investable_universe | Reject at `promoteToWatchlist` boundary; log.warn; catalyst_event still written for audit |
| Two catalysts fire same tick (promotion race) | SQLite `UNIQUE(symbol, exchange) WHERE demoted_at IS NULL` + upsert semantics handles at DB level |
| Demotion conflicts with concurrent promotion | Transactional sweep; promotion holds ephemeral write lock (SQLite default) |

## `/health` surface

New `watchlist` section in `/health`:

```json
{
  "watchlist": {
    "activeCount": 78,
    "byReason": { "news": 42, "research": 18, "earnings": 12, "volume": 4, "feedback": 2 },
    "unenrichedCount": 3,
    "oldestPromotionHours": 54.2,
    "enrichmentFailedCount": 0,
    "lastEnrichRun": "2026-04-17T22:50:00Z",
    "lastDemotionRun": "2026-04-17T22:55:00Z",
    "lastDemotionsRemoved": 12
  }
}
```

`byReason` counts are from `promotion_reasons` — a row with `"news,earnings"` counts once in each bucket.

## Testing strategy

| Surface | Test type | File |
|---|---|---|
| `promoteToWatchlist` idempotency, TTL extension, reason merging | Unit (in-memory SQLite) | `tests/watchlist/promote.test.ts` |
| Each of the 7 demotion rules + never-demote exception | Unit | `tests/watchlist/demote.test.ts` |
| Cap eviction ranking | Unit | `tests/watchlist/filters.test.ts` |
| `buildEnrichmentPrompt` / `parseEnrichmentResponse` | Pure-function unit | `tests/watchlist/enrich.test.ts` |
| `enrichOne` with injected LLM stub | Unit | same file |
| Classifier promotion wiring | Extended existing test | `tests/news/classifier.test.ts` |
| Research agent promotion wiring | Extended existing test | `tests/news/research-agent.test.ts` |
| Pattern analysis feedback trigger | Extended existing test | `tests/learning/pattern-analysis.test.ts` |
| Earnings-catalyst-job, volume-catalyst-job, enrich-job, demote-job | Unit | `tests/scheduler/*.test.ts` |
| Cron registration + schedule mirror | Existing scheduler tests | `tests/scheduler/cron.test.ts` |
| `/health` watchlist section shape + field presence | Unit | `tests/monitoring/health.test.ts` |
| Prompt quality regression | Eval suite | `src/evals/watchlist-enrichment/` (15–20 tasks, code graders + LLM-as-judge) |

Target: +60–80 tests (from 751 → ~820). Eval suite ≤20 Opus calls per run.

## Cost model

- Enrichment: 20–60 Opus calls/day × ~1500 tokens ≈ **$0.40–$1.20/day**
- Eval suite on deploy: 15–20 calls × ~8 deploys/week ≈ $0.30/week
- FMP earnings-calendar: within existing tier, zero incremental
- FMP profile fetch: unchanged from Step 1a
- **Total incremental: $12–$36/month** (matches parent spec)

## Rollout

One PR, all four jobs registered, all three existing-module integrations (classifier, research-agent, pattern-analysis) in one commit. Step 2 has no env-flag kill-switch — it's pure additive infrastructure with no consumer. Safety is: if the whole module is broken, nothing downstream breaks. Step 3 introduces `USE_WATCHLIST` for its own rollback path.

Post-merge validation (manual, on VPS):

1. Trigger a news classification that lands on an investable_universe name → confirm `watchlist` row inserted with `enriched_at=null`
2. Wait for next 15-min enrichment tick → confirm row populated with `research_payload`, `directional_bias`, `horizon`
3. Hit `/health` → confirm `watchlist` section populated
4. Confirm after 72h of no re-firing catalyst, staleness demotion fires

## Success criteria

1. Five promotion triggers all fire at least once within 5 trading days post-deploy
2. Enrichment job maintains `unenrichedCount ≤ 5` throughout sessions
3. `/health` watchlist section accurate and non-empty within 1h of first news/earnings catalyst
4. Zero permanent enrichment failures in first week (malformed output catches indicate prompt bug)
5. Daily cost within $0.40–$1.20 envelope
6. No regressions: 751 tests still pass, typecheck + lint clean, new tests added bring suite to ~820

## Non-goals

- Strategy migration (Steps 3, 4)
- `watchlist_filter` column on strategies (Step 3)
- SEC filings (Form 4, 8-K) — deferred per parent
- Sector rotation trigger — deferred per parent
- Option flow, short interest — out of scope
- Cross-asset signals — out of scope
