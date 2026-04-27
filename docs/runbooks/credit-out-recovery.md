# Credit-Out Recovery

When the Anthropic API credit balance runs out, the service keeps running but every Claude call returns `400 invalid_request_error: Your credit balance is too low`. The system is designed to fail safe (no bad fills, no garbage classifications), but a backlog of unclassified news headlines accumulates and the watchlist misses promotions until it's caught up.

This runbook restores the pipeline after the user has topped up credit.

## Symptoms

- News pipeline keeps polling but `classified_at` never gets set on new rows.
- Dashboard "Last Quote" looks fine (Yahoo/IBKR independent of Claude).
- Watchlist promotions stop appearing for tradeable headlines.
- `journalctl -u trader-v2 | grep "credit balance"` returns hits.

## 1 — Find the credit-out window

```bash
./scripts/vps-ssh.sh "journalctl -u trader-v2 --since '<today> 00:00:00' --no-pager 2>/dev/null | grep -m1 'credit balance'"
```

The first match's timestamp is when credit hit zero. Anything *before* that timestamp ran on credit; anything *after* failed.

## 2 — Check whether morning-once jobs ran before credit-out

Reference table of jobs that run **once** in the morning (UK / Europe/London time). All times below are London → cron-converted to UTC depending on BST/GMT.

| Job | London cron | What it needs | Failure impact |
|---|---|---|---|
| `universe_refresh_weekly` | 03:00 UTC Mon | iShares CSV + Wikipedia | Weekly universe stale |
| `earnings_calendar_sync` | 06:00 | Finnhub | Today's earnings unknown |
| `risk_weekly_reset` | 07:50 Mon | DB only | Weekly counters stuck |
| `risk_daily_reset` | 07:55 | DB only | Daily counters stuck |
| `guardian_start` | 08:00 | DB only | Guardian off until tomorrow |
| `dispatch` (UK pre-open) | 08:05 | Claude (if `CATALYST_DISPATCH_ENABLED=true`) | UK dispatch decisions missed |
| `volume_catalyst_uk` | 08:05 | Yahoo + DB | UK volume catalysts missed |

Verify which actually completed today:

```bash
./scripts/vps-ssh.sh "journalctl -u trader-v2 --since '<today> 00:00:00' --no-pager 2>/dev/null | grep -E 'job\":\"(universe_refresh_weekly|earnings_calendar_sync|risk_weekly_reset|risk_daily_reset|guardian_start|dispatch|volume_catalyst_uk)' | grep -E 'Job starting|Job completed|Job failed'"
```

If a Claude-dependent morning-once job ran *after* the credit-out timestamp, re-run it manually (see §4). If they all ran before, skip to §3.

## 3 — Backfill news classifications

This is the standard fix. The script finds rows with `classified_at IS NULL` from the last N days, re-classifies them, and fires the watchlist-promotion hook on tradeable results. **Stale headlines are not re-routed through the research agent** (Sonnet spend not justified).

```bash
# Dry-run first to see scale
./scripts/vps-ssh.sh "cd /opt/trader-v2 && DRY_RUN=1 sudo -u deploy /home/deploy/.bun/bin/bun scripts/backfill-news-classifications.ts"

# Real run
./scripts/vps-ssh.sh "cd /opt/trader-v2 && sudo -u deploy /home/deploy/.bun/bin/bun scripts/backfill-news-classifications.ts"
```

Default lookback is 2 days. Override with `LOOKBACK_DAYS=N` if the outage was longer.

Expected output:
```
── Summary ──
  Stuck rows found: <N>
  Classified: <N>
  Tradeable: <some subset>
  Watchlist promotions attempted: <some subset>
  Failed (API error): 0
```

`Failed > 0` means credit is still out — don't proceed; ask user to top up.

## 4 — Re-run a specific morning-once job manually

Most morning-once jobs are idempotent and can be re-triggered by importing the function directly. Example for `dispatch`:

```bash
./scripts/vps-ssh.sh "cd /opt/trader-v2 && sudo -u deploy /home/deploy/.bun/bin/bun -e 'import(\"./src/strategy/dispatch.ts\").then(m => m.runDispatch())'"
```

For `risk_daily_reset`, `guardian_start`, etc., the same one-liner pattern works — find the import in `src/scheduler/jobs.ts` and inline-invoke.

**Don't re-run** `universe_refresh_weekly` casually mid-week — it touches the universe table; only re-run if it was the failed job and the data is genuinely stale.

## 5 — Verify recovery

```bash
# Should show 0 unclassified from today
./scripts/vps-ssh.sh "cd /opt/trader-v2 && sqlite3 data/trader.db \"SELECT COUNT(*) FROM news_events WHERE classified_at IS NULL AND created_at >= '<today>T00:00:00Z';\""

# Should show today's promoted symbols
./scripts/vps-ssh.sh "cd /opt/trader-v2 && sqlite3 -header data/trader.db \"SELECT symbol, exchange, promoted_at, enriched_at FROM watchlist WHERE promoted_at >= '<today>T00:00:00Z' ORDER BY promoted_at DESC;\""

# Watchlist size should be in normal range (currently ~150 live)
./scripts/vps-ssh.sh "cd /opt/trader-v2 && sqlite3 data/trader.db 'SELECT COUNT(*) FROM watchlist WHERE demoted_at IS NULL;'"
```

## What NOT to do

- **Don't run `scripts/backfill-research.ts` by reflex.** That script re-runs the Sonnet research agent on tradeable events. After a credit outage, those headlines are stale and the agent's signal degrades fast — wasted spend. Only run it if a specific high-value catalyst was missed and you want it analysed.
- **Don't restart the service to "clear" the failure state.** The retry path inside the classifier is already correct; restarts lose in-flight scheduling state.
- **Don't manually edit `news_events` to set `classified_at` without classification.** `isHeadlineSeen` will then mask the row from the next backfill.

## Prevention (open follow-ups)

- The credit-out errors are warn-level; only the per-symbol `classify-X: retrying after error` surfaces them. A meta-error counter that pages once `>5 credit balance` errors fire in 10 min would catch this without needing a human to notice.
- Daily API budget guard (`canAffordCall`) reads `DAILY_API_BUDGET_USD` but defaults to `0` (= no limit). Setting a soft limit + alert before hard credit-out would convert this from "everything broken" to "budget alarm".

## History

- **2026-04-24:** First credit-out incident. Backfilled 10 stuck headlines + 3 research-agent jobs (research backfill made sense then because the catalysts were still fresh).
- **2026-04-27:** Second credit-out incident. Backfilled 21 stuck headlines, 5 tradeable, 4 watchlist promotions landed (MSFT/META/NVDA/GOOGL). Skipped research backfill — headlines stale by recovery time.
