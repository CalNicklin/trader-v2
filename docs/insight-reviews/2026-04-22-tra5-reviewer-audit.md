# TRA-5 — Strategy 3 reviewer-vs-engine audit (2026-04-22)

**Ticket:** TRA-5 (Insight Review #1)
**Source spec:** `docs/insight-reviews/2026-04-21.md` rank #1 (reshaped)
**Deliverable per ticket:** investigation-only; no code edit in this issue.

## Verdict

**Engine + strategy config agree. Reviewer is hallucinating.**

The reviewer-LLM mislabels strategy 3's `entry_long` trades as "shorts" because the
trade-review prompt exposes the *exit* side (always `SELL` for a long that gets
closed) without an explicit entry-side field. Four downstream insights (293, 301,
302, 303) at confidence 0.82–0.95 are built on this false premise and have been
feeding the learning loop with inverted labels. All four carry `filter_failure`
and/or `catalyst_ignored` tags that flow into evolution + self-improvement prompts.

## Three sources, cross-checked

### 1. Strategy config (source of truth #1)

From `strategies.signals` (row id=3, `earnings_drift_v1`):

```json
{
  "entry_long":  "news_sentiment > 0.3 AND change_percent > 1",
  "entry_short": "news_sentiment < -0.3 AND change_percent < -1",
  "exit":        "hold_days >= 5 OR pnl_pct < -3 OR pnl_pct > 8"
}
```

Positive news + positive move → **long**. Negative news + negative move → short.
Internally consistent with the earnings-drift thesis.

### 2. Engine order side (source of truth #2)

`paper_trades` for the four cited exits (ids 55, 66, 67, 68):

| trade_id | signal_type | symbol | exit side | reasoning column                                          |
|---------:|-------------|--------|-----------|-----------------------------------------------------------|
| 55       | exit        | MRVL   | SELL      | `Exit signal: hold_days >= 5 OR pnl_pct < -3 OR pnl_pct > 8` |
| 66       | exit        | AMZN   | SELL      | same                                                      |
| 67       | exit        | JPM    | SELL      | same                                                      |
| 68       | exit        | META   | SELL      | same                                                      |

The paired **entry** trades (looked up by strategy+symbol+exchange prior to the
exit timestamp) all have `signal_type = entry_long` and `reasoning = "Entry
signal: news_sentiment > 0.3 AND change_percent > 1"` — exactly the
config-defined long entry. Engine matches config.

Example from `paper_trades`: strategy 3 entered `entry_long AMZN BUY 239.89` on
2026-04-14T13:08:45, closed at 2026-04-20T07:03:00 via the `exit` signal
(hold_days=5) selling at 250.56. Net long, winning trade.

### 3. Reviewer insights (divergent)

```
id=293 conf=0.95 "shorted (SELL) on positive news sentiment (>0.3) and positive price movement (>1%)"
id=301 conf=0.92 "Shorted a fundamental positive catalyst (CEO doubling down on $200B AI investment)"
id=302 conf=0.82 "shorted JPM on bearish macro news … JPM actually rallied into strength post-earnings"
id=303 conf=0.92 "Shorted META on positive sentiment and positive price momentum"
```

All four describe these trades as SHORTS. They are LONGS. The reviewer confuses
the exit-leg SELL with a short entry.

Two agree, one disagrees → **Config + Engine are the pair that agree.**

## Why the reviewer hallucinates

Root cause is in `src/learning/trade-review.ts::buildTradeReviewPrompt`:

```ts
const lines = [
  `Strategy: ${trade.strategyName}`,
  `Symbol: ${trade.symbol} (${trade.exchange})`,
  `Side: ${trade.side}`,                                      // ← exit side
  `Entry: ${trade.entryPrice} → Exit: ${trade.exitPrice}`,
  `PnL: ${trade.pnl} (after ${trade.friction} friction)`,
  `Hold: ${trade.holdDays} day(s)`,
  `Signal: ${trade.signalType} — ${trade.reasoning ?? "no reasoning recorded"}`,
];
```

`trade.side` is populated from the **exit** `paperTrades.side` (see
`getTodaysClosedTrades`, lines 166-183). For a long that closes, that is `SELL`.
The prompt shows `Side: SELL`. The entry-side is never surfaced as a labelled
field — it is only inferable from the *reasoning* string (`Entry signal:
news_sentiment > 0.3…`), which the LLM does not parse reliably when a
same-row `Side:` label is present.

Result: every closed long on strategy 3 gets labelled as a "short on positive
news" by the reviewer.

## Blast radius (learning-loop contamination)

These insights do not just stay in the table — they flow into:
- `src/evolution/prompt.ts` (Opus mutation prompts)
- `src/learning/self-improvement-prompt.ts` (if/where it reads `trade_insights`)
- any analytics board that filters on tags like `filter_failure`,
  `catalyst_ignored`, `fundamental_gap`

Any mutation spawned while these 4 insights (and likely many more of the same
shape) are in the pool is reasoning from inverted labels. Strategy 5 is the
most obviously affected — it is a mutation of strategy 3 and was spawned in
exactly this window.

Spot-check on broader scope: any `trade_review` insight whose trade is an
`entry_long` closed via `exit` on a winner should be considered suspect until
the prompt is fixed. A DB sweep (see "Recommended follow-up actions") will
quantify.

## Recommended follow-up actions (NOT part of this ticket)

Per TRA-5 scope: _"No code edit from this issue."_ These are filed for
separate tickets.

1. **Fix `buildTradeReviewPrompt`** (new ticket). Minimal change: derive an
   explicit `Direction: LONG / SHORT` field from the *entry* trade's
   `signal_type` and replace the ambiguous `Side: ${trade.side}` line. The
   entry trade is already fetched in `getTodaysClosedTrades` (line 120) — its
   `signalType` is the authoritative source.

2. **Quarantine the affected insights.** Add a DB flag (or filter) to stop
   evolution/self-improvement from reading `trade_review` insights created
   before the prompt-fix deploy. Specifically flag insights 293, 301, 302, 303
   as known-inverted.

3. **Pause strategy 5 mutation spawning** until (1) lands. Note: setting
   `strategies.status = "paused"` on strategy 5 halts its trading entirely and
   leaves its 2 open positions orphaned (the evaluator loop only iterates
   `status='paper'` rows). Before pausing, close strategy 5's open positions
   (AMZN from 2026-04-15, AMD from 2026-04-16) cleanly, or add a narrower
   "no-spawn" flag. **This is a judgment call — flagging to user, not
   executing from this audit.**

4. **Sweep `trade_insights` for the same shape.** Find every insight whose
   referenced trade was `entry_long` closed via `exit` (or `entry_short`
   closed via `exit`) and tagged `filter_failure` / `catalyst_ignored` /
   `regime_mismatch`. Quantify how much of the learning loop's recent signal
   is built on mislabelled data.

## Impact estimate

- **If only reviewer fix lands:** +10 bps/wk baseline recovery across all
  strategies, because every downstream consumer stops reading corrupted
  labels. Matches the insight-review doc's estimate (rank #1, Alpha).
- **If quarantine + sweep land on top:** unquantified but likely larger —
  some mutations that were blocked by false-positive `filter_failure` insights
  may get re-evaluated.
- **Engine-inversion scenario ruled out:** no +100 bps/wk "preserved edge"
  correction — the engine was never wrong.
