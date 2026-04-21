# Catalyst-Triggered Dispatch — Rollout & Monitoring

**Parent spec:** `docs/superpowers/specs/2026-04-20-catalyst-triggered-dispatch-design.md`
**Plan:** `docs/superpowers/plans/2026-04-20-catalyst-triggered-dispatch.md`
**Progress log:** `docs/progress/2026-04-20-catalyst-triggered-dispatch.md`
**PR:** [#48](https://github.com/CalNicklin/2/pull/48) — merged 2026-04-20
**Flag:** `CATALYST_DISPATCH_ENABLED` — default `false`; currently **off** (Phase B)
**Deployed commit:** `112a8bf` (includes PRs #48 + #49); verified 2026-04-21 06:00 UTC.

## Why it exists

Strategy evaluation is gated by dispatch. Dispatch only runs 4× per day (08:05, 14:35, 16:35, 18:00 BST). Between boundaries, the set of activated `(strategy, symbol)` pairs is frozen — even if a high-urgency catalyst lands on a symbol that isn't currently activated, the evaluator ignores it. 14 d of paper trades cluster heavily around 13 UTC (30 / 80 trades in that one hour). Catalyst-triggered dispatch fires a supplementary dispatch within seconds of a high-urgency news event.

## What shipped

**Structural (always-on, no flag):**
- `dispatch_decisions` SQLite table (migration 0018) replaces the module-level `latestDecisions` array.
- `src/strategy/dispatch-store.ts` — read path with catalyst-over-scheduled precedence, write helpers, expire/cleanup.
- `runDispatch` writes to DB; evaluator reads via `getActiveDecisions()`.
- Nightly cleanup job `dispatch_decisions_cleanup` at 22:20 UK.

**Catalyst path (flag-gated):**
- `CATALYST_DISPATCH_ENABLED` env flag (default `false`).
- `src/strategy/catalyst-dispatcher.ts` — 60 s debounce per symbol, 30 min cooldown, 20 / day cap.
- `src/strategy/catalyst-prompt.ts` — symbol-scoped, strategy-broad Haiku prompt.
- `src/news/ingest.ts` enqueues catalyst dispatch when `tradeable && urgency==='high'` and the primary symbol is in any graduated strategy's universe.
- Fire-and-forget evaluator kick for newly-activated strategies on that symbol.
- `/health` payload exposes `catalyst: { dispatchesToday, capHit, lastDispatchedAt }`.
- 10-task eval suite at `src/evals/catalyst-dispatch/` with `eval:catalyst-dispatch` script.

## Rollout checklist

### Phase A — Day 0 (right after deploy) — ✅ **complete 2026-04-21**

1. **Verify migration 0018 applied on prod.** Issue [#32](https://github.com/CalNicklin/trader-v2/issues/32) means this cannot be assumed.
   ```bash
   ./scripts/vps-ssh.sh "sqlite3 /opt/trader-v2/data/trader.db 'SELECT COUNT(*) FROM __drizzle_migrations;'"
   ./scripts/vps-ssh.sh "sqlite3 /opt/trader-v2/data/trader.db \"SELECT name FROM sqlite_master WHERE name='dispatch_decisions';\""
   ```
   Pass: journal count 19 **and** `dispatch_decisions` table exists. If the table is missing, **stop and hotfix before any more activity** — the evaluator will crash on every tick because it reads via `getActiveDecisions()`.

2. **Service restarts cleanly.**
   ```bash
   ./scripts/vps-status.sh
   ```
   Pass: `systemctl status` active, `/health` 200, `/health.catalyst` present.

### Phase A — actual 2026-04-21 post-mortem

Phase A surfaced a latent incident: PR #48 (and #46, #49) had not actually deployed to prod. Deploys had been silently failing since 2026-04-20 14:24 UTC because two untracked files on the prod working tree (`scripts/backfill-news-classifications.ts`, `scripts/repromote-tradeable-news.ts`) blocked every `git pull` with "untracked working tree files would be overwritten by merge — Aborting".

- ~14 h of stacked-up unmerged commits: #46, #48, #49.
- False alarm during diagnosis: operator assumed issue #32 had recurred and manually `CREATE TABLE`'d `dispatch_decisions`. That was wrong — the code wasn't deployed yet, the migration had never attempted. The premature table was `DROP`'d before CI re-ran so `db:migrate` could apply 0018 cleanly.
- Fix: `rm` the two untracked files on prod → re-run the failed workflow → 19 migrations applied, table + indexes present, `/health.catalyst` populated.

Lessons documented in `docs/rollout-monitoring.md` §4:
1. CI deploy health is a daily check (`gh run list --limit 5 --branch main`).
2. Never create files directly on the prod working tree — use a PR so CI deploys them properly.
3. Consider a post-deploy `/health` probe in the GitHub Actions workflow to turn silent-failed-deploys into visible-broken-builds.

### Phase B — First 24 h (flag OFF, structural path only) — **in progress, started 2026-04-21 06:00 UTC**

3. **`dispatch_decisions` populates from the next scheduled dispatch.** After the next 14:35 BST (or 08:05 next day):
   ```bash
   ./scripts/vps-ssh.sh "sqlite3 /opt/trader-v2/data/trader.db 'SELECT source, action, COUNT(*) FROM dispatch_decisions WHERE expires_at > datetime(\"now\") GROUP BY source, action;'"
   ```
   Pass: rows with `source='scheduled'` present; no `catalyst` rows (flag still off).

4. **Evaluator's activation count matches DB.**
   ```bash
   ./scripts/vps-logs.sh --since "2 hours ago" | grep "Evaluating graduated"
   ```
   Pass: `activated: N` in logs ≈ count of `scheduled + activate` rows in DB.

5. **No regression in paper trade volume.** 24 h count ~ prior daily average. If trades collapse to zero, the DB read path has a bug.

6. **Nightly cleanup job fires at 22:20 UK.**
   ```bash
   ./scripts/vps-logs.sh --since "1 hour ago" | grep dispatch_decisions_cleanup
   ```
   Pass: `Cleanup of expired dispatch decisions` log line with `deleted: N` (N can be 0).

### Phase C — Flag flip (after 24 h green)

7. On VPS, edit `.env` to `CATALYST_DISPATCH_ENABLED=true`, then:
   ```bash
   ./scripts/vps-ssh.sh "sudo systemctl restart trader-v2"
   ```

8. **First 60 min post-flip.** Watch `/health`:
   ```bash
   watch -n 30 'curl -s http://<VPS_HOST>:3847/health | jq .catalyst'
   ```
   Expected: `dispatchesToday` stays 0 until the first high-urgency news event on a graduated symbol, then ticks 0 → 1. If it jumps to 20+ immediately, a feedback loop has formed — **kill the flag and investigate the classifier / enqueue gate**.

### Phase D — First 7 trading days post-flip

9. **Cost < \$0.05 / day on `catalyst_dispatch` phase.**
   ```bash
   ./scripts/vps-ssh.sh "sqlite3 /opt/trader-v2/data/trader.db 'SELECT date(created_at), SUM(cost_usd) FROM token_usage WHERE phase=\"catalyst_dispatch\" GROUP BY 1 ORDER BY 1 DESC LIMIT 10;'"
   ```

10. **Cap hits are rare (< 1 / week).** `catalyst.capHit=true` in `/health` means either a legitimate news storm or a classifier false-positive loop.

11. **Paper-trade hourly distribution shifts.** Success = ≥ 30 % of paper trades in the 14 d post-flip window land outside ±30 min of `{08:05, 14:35, 16:35, 18:00}` BST. Baseline is ≈ 0 %.
    ```sql
    SELECT strftime('%H', created_at) AS hour, COUNT(*)
    FROM paper_trades
    WHERE created_at > datetime('now', '-14 days')
    GROUP BY hour;
    ```

12. **No elevated loss rate on catalyst-sourced trades.** Join `paper_trades → dispatch_decisions (source='catalyst') → news_events (source_news_event_id)` and compare win rate / expectancy vs the non-catalyst cohort over the same window.

## Kill-switch

If any phase fails or produces unexplained behaviour:

```bash
./scripts/vps-ssh.sh "cd /opt/trader-v2 && sed -i 's/CATALYST_DISPATCH_ENABLED=true/CATALYST_DISPATCH_ENABLED=false/' .env && sudo systemctl restart trader-v2"
```

The structural DB path is always-on and cannot be flag-disabled without a code revert. If that's the problem, revert PR #48 on main and redeploy.

## Success criteria (per spec §18)

- ≥ 30 % of paper trades over 14 d occur outside a ±30 min window around scheduled dispatch boundaries.
- No increase in loss rate attributable to catalyst-dispatched trades.
- Catalyst Haiku spend stays < \$0.05 / day.
- Zero regression in scheduled dispatch behaviour.

## Open follow-ups

- None yet. Add here as monitoring turns up issues.
