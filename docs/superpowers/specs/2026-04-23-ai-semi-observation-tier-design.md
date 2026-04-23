# AI-Semi Universe Tier — 21-day Zero-Size Observation Mode

**Status:** Draft — 2026-04-23
**Ticket:** TRA-11
**Source:** `docs/insight-reviews/2026-04-21.md` rank #7 (Opp, amended)

## One-line goal

Instrument a 13-symbol AI-semiconductor-supply-chain basket as an observation-only universe tier. On each gate-fire (defined below), record a hypothetical basket snapshot; at T+5d record the same basket's move; tally 21 days' worth of hit-rates to decide whether to promote to a sized tier.

## Problem we're answering

The 2026-04-21 snapshot showed heavy AI-semi catalyst clustering (AVGO×10, INTC×4, MRVL×3, SMCI×5, TSM×4, ASML×2) plus notable misses (ANET +9.5% conf 0.98, CRWV +14.7%) in the missed-opportunity ledger. That ledger is **survivorship-biased** — it only records symbols that moved enough to be noticed. Acting on it directly (sizing up a live AI-semi tier) would curve-fit to the winners.

The Skeptic's amendment: build the **null-day denominator** by running the tier in observation mode. Only flip to sized if a pre-registered hit-rate threshold holds.

## Out of scope

- Trading any of these symbols from this tier. Observation-only. Zero position size.
- Modifying existing strategies' universes. This is additive instrumentation.
- Automatic promotion to sized mode. Promotion is a human decision after the 21-day window closes, based on the pre-registered threshold.

## Symbol basket (fixed list)

```ts
export const AI_SEMI_SUPPLYCHAIN_BASKET = [
  "AVGO",  // Broadcom
  "MRVL",  // Marvell
  "TSM",   // TSMC (US ADR)
  "ASML",  // ASML (US ADR)
  "AMAT",  // Applied Materials
  "KLAC",  // KLA Corp
  "LRCX",  // Lam Research
  "SMCI",  // Super Micro
  "MU",    // Micron
  "WDC",   // Western Digital
  "ANET",  // Arista Networks
  "ADI",   // Analog Devices
  "INTC",  // Intel
] as const;
```

All NASDAQ/NYSE. No exchange qualification needed — the basket is US-only by design (it's a supply-chain group, geographic diversification adds noise here).

## Gate definition

A "gate fire" is defined as:

**A newly-classified high-urgency (`urgency = "high"`) news event on NVDA, AVGO, or a hyperscaler (AMZN, MSFT, GOOGL, META) where the classifier's `tradeable = true` flag is set.**

Gate fires are already implicitly surfaced by the existing news classifier — we just need to subscribe to the event. The gate is **not** based on price action; it's purely catalyst-driven.

Rationale for trigger symbols:
- **NVDA** — the AI-semi cycle bellwether. Most AI-semi moves downstream of NVDA news.
- **AVGO** — second-tier bellwether; owns AI networking + custom silicon exposure.
- **Hyperscaler capex signals** (AMZN/MSFT/GOOGL/META) are the demand side. Earnings guidance on "AI capex" moves the whole basket.

NVDA itself is not in the observation basket — it's the trigger, not the target. Including it would circularly inflate hit-rates.

## Schema: `gate_diagnostic` table

```ts
export const gateDiagnostic = sqliteTable("gate_diagnostic", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gateName: text("gate_name").notNull(),            // "ai_semi_supplychain_v1"
  triggerSymbol: text("trigger_symbol").notNull(),  // NVDA | AVGO | AMZN | MSFT | GOOGL | META
  triggerNewsEventId: integer("trigger_news_event_id").notNull(),  // FK into news_events
  firedAt: text("fired_at").notNull(),              // ISO
  basketSnapshotAtFire: text("basket_snapshot_at_fire").notNull(), // JSON: { SYM: price }
  basketSnapshotAt5d: text("basket_snapshot_at_5d"),               // JSON: { SYM: price }, nullable until T+5d measurement
  basketAvgMovePct: real("basket_avg_move_pct"),                   // nullable until measured
  basketHitThreshold: integer("basket_hit_threshold", { mode: "boolean" }),  // avg move ≥ +2%? — nullable
  measuredAt: text("measured_at"),                  // ISO, nullable until measurement runs
});
```

- `basketSnapshotAtFire` is populated synchronously when the gate fires. No lookback query — we record prices as-of that moment.
- `basketSnapshotAt5d`, `basketAvgMovePct`, `basketHitThreshold`, `measuredAt` are populated by a nightly measurement job that scans for fires ≥5 days old with null `measuredAt`.

## Pre-registered activation threshold

> **≥55%** of gate-fires in the 21-day window produce a basket **average move ≥ +2%** within 5 trading days, compared against a ~50% random baseline.

"Random baseline" here = the hit rate on an equivalently-sized random 13-stock basket sampled from the investable universe on a non-gate-fire day. Computed in the end-of-window analysis script, not as a live comparison.

This threshold is **committed before data accumulation**, per the Skeptic's amendment. If it fails we retire the tier; if it passes we file a follow-up ticket to flip to sized mode with proposed position_size and the archetype + stop-loss floor.

## Components

### New

1. **`src/universe/ai-semi-basket.ts`** — the symbol constant + gate-fire detection function `detectAiSemiGate(newsEvent): GateFireMetadata | null`.
2. **`src/jobs/ai-semi-observer.ts`** — two handlers:
   - `onNewsClassified(event)` — synchronous subscription to the news-classifier post-write hook. If the event matches the gate, snapshot the basket prices from `quotes_cache` and insert a `gate_diagnostic` row.
   - `runAiSemiMeasurementSweep()` — nightly job. Scans `gate_diagnostic` for `measuredAt IS NULL` rows where `firedAt <= now - 5 trading days`; fetches current quotes, computes avg basket move, writes back.
3. **`drizzle/migrations/0021_gate_diagnostic.sql`** — new table.

### Modified

1. **`src/news/classifier.ts`** — add a post-classify hook so observers can subscribe without the classifier knowing about them. (Keeps the classifier itself scope-clean — news changes #7 amendment-history).
2. **`src/scheduler/cron.ts`** + **`src/scheduler/jobs.ts`** — wire the nightly measurement sweep (e.g. 22:15 UTC, after US close).
3. **`src/monitoring/dashboard-data.ts`** — small tile: gate fires count / hit-threshold count / days-elapsed-of-21.

## Rollout

1. **PR 1 (this PR):** schema + observer + measurement job + tests + dashboard tile. Observer runs on deploy (no flag) but position_size=0 is enforced by the observer itself — there's no path from this tier to a live order.
2. **T+21 day review:** analyst reads dashboard; if ≥55% hit-rate, file a sized-tier ticket with the specific size + archetype; else retire.
3. The sized-tier spawn is **a separate ticket**, not part of this rollout.

## Failure modes + mitigations

| Risk | Mitigation |
|---|---|
| Classifier misclassifies an NVDA news event as tradeable → spurious gate fires | Gate is downstream of an existing prod-validated classifier. False positives pad the denominator, not the numerator. |
| Basket avg move at T+5d is computed after a gap / holiday (calendar vs trading days) | "5 trading days" — measurement job uses `scheduler/sessions.ts::isExchangeOpen` to count trading days, not calendar. |
| Quote cache is stale at snapshot time | Acceptable for observation — all baselines use the same snapshot rule, so hit-rate comparison is internally consistent. |
| A measurement row gets stuck `measuredAt=null` past T+5d (e.g. quote missing) | Sweep logs the gap and sets a sentinel value (e.g. `measuredAt = now`, `basketHitThreshold = null`) so it doesn't retry forever; analyst reviews null rows at T+21. |
| Observer job errors silently and we miss fires | Observer failures logged at `error`; end-of-window review checks gate-fire count vs classifier high-urgency count for the trigger symbols and flags discrepancy. |

## Tests / evals

- Unit: `detectAiSemiGate` returns metadata for NVDA/AVGO/hyperscaler high-urgency tradeable events; null for others. 6+ cases.
- Unit: basket snapshot writes all 13 symbols' prices; tolerates missing quotes by recording null per-symbol.
- Unit: measurement job picks up 5d-old unmeasured rows; ignores younger rows; ignores already-measured rows.
- Integration: simulate 3 gate-fires across 5 days (mocked time); run measurement sweep; assert `basketHitThreshold` rows populated correctly.
- Eval (optional v1): synthetic fixture of known +3% / -1% basket moves to validate the hit-threshold arithmetic.

## Open questions for reviewer

1. **Trigger set** — is NVDA + AVGO + 4 hyperscalers right, or should we include META/GOOGL only for AI-capex guidance items (not all high-urgency news)? Narrowing reduces false-positives; widening increases denominator size. Default: wide (6 triggers) — Skeptic wants a solid null-day denominator.
2. **"Hyperscaler catalyst" semantics** — are all high-urgency AMZN news items gates, or only ones tagged with AI-specific event_types? v1 is "any high-urgency tradeable", which is wider. Can narrow in a follow-up if FP rate is too high.
3. **Where does the observation dashboard live?** Inline in the existing learning-loop tab, or a new "Observations" section? v1 proposal: new section, feels cleaner. Open to inline if you prefer.
4. **Should `measuredAt IS NULL` rows past T+7d be explicitly quarantined or just logged?** v1: quarantine with sentinel (avoids infinite retry), flag in review.
