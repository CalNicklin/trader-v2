# Catalyst-Triggered Dispatch — Design Spec

**Date:** 2026-04-20
**Branch:** `feat/catalyst-triggered-dispatch`
**Status:** Design — awaiting review

## 1. Problem

Strategy evaluation is gated by dispatch. Dispatch only runs 4 times per day
(08:05, 14:35, 16:35, 18:00 BST). Between those boundaries, the set of
activated `(strategy, symbol)` pairs is frozen — even if a high-urgency
catalyst (earnings surprise, profit warning, FDA decision, halt) lands on a
symbol that isn't in the current activation set, the evaluator ignores it.

Evidence: 14d of paper trades cluster heavily around 13 UTC (30/80 trades),
which is the 14:35 BST dispatch window. Trades almost never fire mid-session
on genuine mid-session catalysts.

## 2. Goal

Let catalysts trigger dispatch on their own, between scheduled boundaries, so
that a high-urgency news event can activate a `(strategy, symbol)` pair within
seconds rather than hours.

Scheduled dispatch remains unchanged. Catalyst dispatch is a supplementary
path layered on top.

## 3. Non-Goals

- Replacing the scheduled dispatch cadence.
- Activating on medium- or low-urgency news.
- Peer/sector propagation (activating neighbours of a catalyst symbol).
- Changing which model powers dispatch (scheduled and catalyst both stay on
  `CLAUDE_MODEL_FAST` / Haiku).

## 4. Trigger Condition

A catalyst dispatch is triggered when, for a newly-classified news event:

- `tradeable === true`
- `urgency === 'high'`
- The primary symbol appears in at least one graduated strategy's universe
  (probation / active / core).

Re-evaluation of already-activated pairs is implicit: the catalyst dispatcher
asks Claude `activate | skip` for every graduated strategy on the event's
symbol, so a profit warning on a symbol currently activated `long` can be
flipped to `skip` (or the existing activation overridden by a later decision).

## 5. Scope of a Catalyst Dispatch Call

Symbol-scoped, strategy-broad:

- Input: one symbol, one triggering news event, all graduated strategies,
  current regime snapshot if available.
- Output: `DispatchDecision[]` for that single symbol across N strategies.

Rationale: small prompt (cheap Haiku), fast, naturally re-evaluates existing
activations for the symbol.

## 6. Rate Limits

Per-process in-memory state:

- **60s debounce per symbol** — collapses bursts of correlated headlines
  (earnings releases commonly produce 3–5 headlines within seconds). A later
  event during the debounce window resets the timer and updates the pending
  `newsEventId` reference.
- **30-min cooldown per symbol** — after a dispatch fires for a symbol, no
  new catalyst dispatch for that symbol for 30 minutes.
- **20/day hard cap across all symbols** — safety net against classifier
  false-positive loops or genuine news storms.

Cost envelope: ~$0.002 per Haiku call × 20/day ≈ $0.04/day worst case.
Scheduled dispatch cost is unchanged.

## 7. State Merge: DB-Backed Dispatch Decisions

Today, scheduled dispatch decisions live in a module-level array
(`latestDecisions` in `src/strategy/dispatch.ts:27`). This has two problems
that we fix simultaneously:

1. VPS restart wipes all activations until the next scheduled boundary.
2. There is no natural place for a catalyst decision to coexist with a
   scheduled decision.

**Design:** a new `dispatch_decisions` table. Both scheduled and catalyst
dispatches write rows to it. The evaluator reads "active" rows
(`expires_at > now()`). The in-memory `latestDecisions` array is removed.

### Schema

```sql
CREATE TABLE dispatch_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('activate', 'skip')),
  reasoning TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('scheduled', 'catalyst')),
  source_news_event_id INTEGER,           -- nullable, FK to news_events
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  FOREIGN KEY (source_news_event_id) REFERENCES news_events(id)
);

CREATE INDEX idx_dispatch_decisions_active
  ON dispatch_decisions (expires_at, action);
CREATE INDEX idx_dispatch_decisions_strategy_symbol
  ON dispatch_decisions (strategy_id, symbol);
```

### Expiry

- **Scheduled** decisions: `expires_at = next scheduled dispatch boundary +
  30min buffer`. On each scheduled `runDispatch`, rows with
  `source = 'scheduled'` are expired (updated to `expires_at = now()`) before
  new scheduled rows are written. Catalyst rows are not touched.
- **Catalyst** decisions: `expires_at = now() + 4h`. They fade on their own.

### Read path

`getActiveDecisions()` replaces `getLatestDispatchDecisions()`. It returns at
most one decision per `(strategy_id, symbol)` pair with the following
precedence:

1. If a catalyst row and a scheduled row both exist for the same pair, the
   catalyst row wins (it's newer, more specific, and driven by a fresher
   signal). Equivalent SQL: `ROW_NUMBER() OVER (PARTITION BY strategy_id,
   symbol ORDER BY (source='catalyst') DESC, created_at DESC) = 1`.
2. Expired rows (`expires_at <= now()`) are excluded.

The evaluator's existing `activatedPairs` / `skippedPairs` logic is unchanged
— only the source of the `DispatchDecision[]` array changes. Precedence
avoids the case where a scheduled `skip` would otherwise override a catalyst
`activate`.

### Cleanup

A nightly `post_close` job (22:30) deletes rows where
`expires_at < now() - 24h` to keep the table bounded.

## 8. Integration Point

Hook the catalyst gate into `src/news/news-poll-job.ts`, immediately after
the classifier has run and `storeNewsEvent` has persisted the row. Pseudocode:

```ts
const newsEventId = await storeNewsEvent(...);

// NEW: catalyst gate
if (
  classification.tradeable &&
  classification.urgency === 'high' &&
  await isSymbolInGraduatedUniverse(primarySymbol)
) {
  catalystDispatcher.enqueue(primarySymbol, exchange, newsEventId);
}
```

The dispatcher is in-process; no separate poller or queue infrastructure.

## 9. Evaluator Kick

After a catalyst dispatch writes rows to `dispatch_decisions`, the dispatcher
calls `kickEvaluatorForSymbol(symbol, exchange)`. This runs, synchronously in
the dispatcher's async context:

- Fetch `getQuoteAndIndicators(symbol, exchange)`.
- Build `riskState` (as the evaluator does today).
- For each strategy newly activated on this symbol, call
  `evaluateStrategyForSymbol(strategy, symbol, exchange, data, riskState)`.

Rationale: waiting up to 10 minutes for the next scheduled evaluator tick
defeats the "react fast to catalysts" premise. This is a *scoped* eval — one
symbol, N strategies — not a full universe sweep, so latency is bounded.

If the kick throws, it is logged but does not roll back the DB rows. The next
10-min evaluator tick will still see them.

## 10. Components

New files:

- `src/strategy/catalyst-dispatcher.ts` — debounce / cooldown / cap state,
  `enqueue(symbol, exchange, newsEventId)`, `runCatalystDispatch(symbol,
  exchange, newsEventId)`.
- `src/strategy/dispatch-store.ts` — `getActiveDecisions()`,
  `writeScheduledDecisions()`, `writeCatalystDecisions()`,
  `expireScheduledDecisions()`, `cleanupExpiredDecisions()`.
- `src/strategy/catalyst-prompt.ts` — prompt builder for the
  single-symbol-across-strategies case (analogous to `dispatch-prompt.ts`).
- `drizzle/migrations/NNNN_dispatch_decisions.sql` — table + indexes.
- `tests/strategy/catalyst-dispatcher.test.ts`,
  `tests/strategy/dispatch-store.test.ts`,
  `tests/strategy/catalyst-prompt.test.ts`.
- `src/evals/dispatch/` — small eval suite for catalyst dispatch correctness.

Modified files:

- `src/strategy/dispatch.ts` — `runDispatch` writes to DB via
  `dispatch-store.ts` and expires previous scheduled rows. Remove
  `latestDecisions`, `getLatestDispatchDecisions`, `clearDispatchDecisions`.
- `src/strategy/evaluator.ts` — replace `getLatestDispatchDecisions()` call
  at line 529 with `getActiveDecisions()`.
- `src/news/news-poll-job.ts` — one `catalystDispatcher.enqueue(...)` call
  added after `storeNewsEvent`.
- `src/db/schema.ts` — add `dispatchDecisions` table.
- `src/config.ts` — add `CATALYST_DISPATCH_ENABLED` (default `false`).
- `src/scheduler/cron.ts` — add nightly cleanup job.
- `src/monitoring/cron-schedule.ts` — mirror the cleanup job.
- `src/monitoring/status.ts` (and any monitored metrics helpers) — expose
  catalyst counters.

## 11. Budget & Telemetry

- `canAffordCall(0.005)` check before each catalyst dispatch. On exhaustion,
  log and drop.
- `recordUsage('catalyst_dispatch', inputTokens, outputTokens)` — distinct
  phase so cost tracking separates scheduled from catalyst spend.
- `agent_logs` rows with `phase='catalyst_dispatch'` carrying symbol,
  `news_event_id`, `decisions_count`, `activated_count`, `latency_ms`.
- Health endpoint exposes:
  - `catalyst_dispatches_today: number`
  - `catalyst_cap_hit: boolean`
  - `catalyst_last_dispatched_at: string | null`

## 12. Observability UI

Dashboard (monitoring subsystem-tabs) gets one new card on the Strategy tab:
"Catalyst activations (today)" with count and last-fired timestamp.

## 13. Error Handling

| Failure | Behaviour |
|---|---|
| Anthropic call fails | Retry once via `withRetry`; then log + drop. Do not re-queue. |
| Classifier fires for symbol not in any graduated universe | Blocked at enqueue gate; no cost. |
| DB write failure on `dispatch_decisions` | Fatal log; do not call evaluator kick. |
| Evaluator kick throws | Logged; DB rows remain; next 10-min tick picks them up. |
| Process restart mid-debounce | Debounce timer lost; symbol becomes re-triggerable. Cooldown (in-memory) also lost — acceptable since cooldown is cost guard, not correctness. |

## 14. Feature Flag & Rollout

- `CATALYST_DISPATCH_ENABLED=false` on first deploy.
- For 24h, observe `dispatch_decisions` table populating correctly from
  scheduled dispatches only. Verify evaluator reads from DB path.
- Flip to `true`. Monitor catalyst counters and any net-change in paper trade
  distribution across hours.

When disabled: `catalystDispatcher.enqueue` is a no-op. Scheduled dispatch
still uses the new DB path (there is no flag for the DB migration — it's
structural).

## 15. Testing Strategy

### Unit
- Debounce collapses 5 enqueues in 30s into 1 dispatch.
- Cooldown blocks a second enqueue 5 minutes after a dispatch.
- Daily cap blocks the 21st dispatch.
- Out-of-universe symbol is blocked at enqueue.
- `expireScheduledDecisions` does not affect catalyst rows.
- `getActiveDecisions` filters by `expires_at`.
- When a scheduled `skip` and a catalyst `activate` exist for the same
  `(strategy, symbol)`, `getActiveDecisions` returns the catalyst row only.

### Integration
- Simulate a classifier output → verify `dispatch_decisions` row appears with
  `source='catalyst'` and an evaluator evaluation happens for that symbol.
- Scheduled dispatch still writes a full row set and evaluator reads them.

### Eval
- `src/evals/dispatch/` — 10 tasks:
  - Earnings beat on activated symbol → expect activation retained / flipped
    long.
  - Profit warning on activated long → expect `skip`.
  - FDA positive decision on non-activated symbol → expect activation.
  - Vague / low-signal headline that mis-classified as high → expect skip.
  - Halt → expect skip across all strategies.
  - Acquisition target → expect appropriate direction.

### Regression
- Existing dispatch and evaluator tests must pass with `CATALYST_DISPATCH_ENABLED=false`.

## 16. Migration / Deployment Order

1. Ship DB migration (empty table).
2. Ship `dispatch-store.ts` + switch scheduled dispatch and evaluator to
   DB-backed path. Feature flag still off. Observe 24h.
3. Ship `catalyst-dispatcher.ts` + news-poll-job hook + eval suite.
4. Flip `CATALYST_DISPATCH_ENABLED=true` on VPS.
5. Observe paper-trade hourly distribution over the following 7 days; expect
   tails to thicken outside dispatch boundaries and the 13 UTC spike to
   soften.

## 17. Open Questions (not blockers)

- If paper-trade distribution doesn't flatten meaningfully after 7d of
  catalyst dispatch, revisit options 2 (raise scheduled dispatch cadence) and
  explore medium-urgency inclusion.
- Whether catalyst activations should have a longer TTL than 4h during
  sessions with known clustered catalysts (e.g., earnings season). Deferred.

## 18. Success Criteria

- At least 30% of paper trades over a 14d window occur outside a ±30min
  window around scheduled dispatch boundaries (currently ~0%).
- No increase in loss rate attributable to catalyst-dispatched trades
  (measured via `source_news_event_id` joined to trade outcomes).
- Catalyst dispatch Haiku spend stays under $0.05/day.
- Zero regression in scheduled dispatch behaviour.
