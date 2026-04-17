#!/usr/bin/env bash
# Pull a read-only snapshot of trader-v2 state into .claude-team-data/
# for consumption by the /review-insights agent team.
# Usage: ./scripts/pull-insight-snapshot.sh
# Prints the snapshot path on the last stdout line.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/.claude-team-data"
mkdir -p "$OUT_DIR"

TS=$(date -u +"%Y%m%d-%H%M%S")
OUT="$OUT_DIR/snapshot-$TS.md"

SQL_FILE=$(mktemp)
TMP_HEADER=$(mktemp)
trap 'rm -f "$SQL_FILE" "$TMP_HEADER"' EXIT

# ── Build the SQL batch ────────────────────────────────────────────────────
# Uses sqlite3's .mode markdown for nice tables, and .print to insert headers
# so every section is clearly labelled in the output file.

cat > "$SQL_FILE" <<'SQL'
.mode markdown
.headers on

.print # Trader-v2 insight snapshot
.print

.print ## 1. Population snapshot
.print
SELECT status, COUNT(*) AS count
  FROM strategies
 GROUP BY status;
.print

.print ## 2. Per-strategy metrics (active / probation / paper / core)
.print
SELECT s.id,
       s.name,
       s.status,
       s.generation,
       m.sample_size,
       m.win_rate,
       m.expectancy,
       m.profit_factor,
       m.sharpe_ratio,
       m.max_drawdown_pct,
       m.consistency_score
  FROM strategies s
  LEFT JOIN strategy_metrics m ON m.strategy_id = s.id
 WHERE s.status IN ('active','probation','paper','core')
 ORDER BY m.sharpe_ratio IS NULL, m.sharpe_ratio DESC;
.print

.print ## 3. Recent paper trades (last 30 days)
.print
SELECT strategy_id,
       symbol,
       exchange,
       side,
       quantity,
       price,
       friction,
       pnl,
       signal_type,
       created_at
  FROM paper_trades
 WHERE created_at >= datetime('now','-30 days')
 ORDER BY created_at DESC;
.print

.print ## 4. Unacted high-confidence insights (last 60 days)
.print
SELECT id,
       insight_type,
       strategy_id,
       tags,
       confidence,
       created_at,
       substr(observation, 1, 300) AS observation,
       suggested_action
  FROM trade_insights
 WHERE (led_to_improvement IS NULL OR led_to_improvement = 0)
   AND confidence >= 0.6
   AND created_at >= datetime('now','-60 days')
 ORDER BY confidence DESC, created_at DESC
 LIMIT 200;
.print

.print ## 5. Insights already acted on (last 30 days) — do NOT re-propose
.print
SELECT id,
       insight_type,
       created_at,
       substr(observation, 1, 200) AS observation,
       suggested_action
  FROM trade_insights
 WHERE led_to_improvement = 1
   AND created_at >= datetime('now','-30 days')
 ORDER BY created_at DESC;
.print

.print ## 6. Graduation events (last 30 days)
.print
SELECT strategy_id,
       event,
       from_tier,
       to_tier,
       evidence,
       created_at
  FROM graduation_events
 WHERE created_at >= datetime('now','-30 days')
 ORDER BY created_at DESC;
.print

.print ## 7. Strategy mutations (last 30 days)
.print
SELECT parent_id,
       child_id,
       mutation_type,
       parameter_diff,
       parent_sharpe,
       child_sharpe,
       created_at
  FROM strategy_mutations
 WHERE created_at >= datetime('now','-30 days')
 ORDER BY created_at DESC;
.print

.print ## 8. News classification volume & tradeable rate (last 30 days)
.print
SELECT date(classified_at) AS d,
       COUNT(*) AS classified,
       SUM(CASE WHEN tradeable = 1 THEN 1 ELSE 0 END) AS tradeable
  FROM news_events
 WHERE classified_at >= datetime('now','-30 days')
 GROUP BY d
 ORDER BY d DESC;
.print

.print ## 9. Token spend by job (last 30 days)
.print
SELECT job,
       COUNT(*) AS calls,
       SUM(input_tokens) AS tokens_in,
       SUM(output_tokens) AS tokens_out,
       ROUND(SUM(estimated_cost_usd), 2) AS cost_usd
  FROM token_usage
 WHERE created_at >= datetime('now','-30 days')
 GROUP BY job
 ORDER BY cost_usd DESC;
.print

.print ## 10. Footer — about this snapshot
.print - Database: /opt/trader-v2/data/trader.db on VPS
.print
SQL

# ── Prepend a file header with timestamp, VPS git SHA, DB size ─────────────

GIT_SHA=$("$SCRIPT_DIR/vps-ssh.sh" "cd /opt/trader-v2 && git rev-parse --short HEAD" 2>/dev/null || echo "unknown")
DB_SIZE=$("$SCRIPT_DIR/vps-ssh.sh" "stat -c%s /opt/trader-v2/data/trader.db" 2>/dev/null || echo "unknown")

{
  echo "<!-- trader-v2 insight snapshot -->"
  echo ""
  echo "- **Generated (UTC):** $(date -u +"%Y-%m-%d %H:%M:%S")"
  echo "- **VPS git SHA:** \`$GIT_SHA\`"
  echo "- **DB size (bytes):** $DB_SIZE"
  echo ""
} > "$TMP_HEADER"

# ── Run the SQL batch over SSH, append to the header ──────────────────────

"$SCRIPT_DIR/vps-ssh.sh" "sqlite3 -bail /opt/trader-v2/data/trader.db" < "$SQL_FILE" >> "$TMP_HEADER"
mv "$TMP_HEADER" "$OUT"

# ── Fail-fast checks ──────────────────────────────────────────────────────

SIZE_BYTES=$(wc -c < "$OUT" | tr -d ' ')
if [ "$SIZE_BYTES" -lt 2048 ]; then
  echo "ERROR: snapshot too small ($SIZE_BYTES bytes < 2048) — SQL likely failed silently." >&2
  echo "File kept at $OUT for debugging." >&2
  exit 1
fi

# Counts markdown data rows whose first column starts with a digit (integer ID or date).
# Intentionally misses sections whose first column is a label (e.g. strategy status, job name) — they're not the primary sanity check.
INSIGHT_ROWS=$(grep -c '^| [0-9]' "$OUT" || true)
if [ "$INSIGHT_ROWS" -lt 10 ]; then
  echo "ERROR: snapshot contains $INSIGHT_ROWS data rows across all sections — need at least 10." >&2
  echo "Either the DB is empty or the queries failed. File at $OUT." >&2
  exit 1
fi

echo "Snapshot: $OUT"
echo "Size: $SIZE_BYTES bytes, data rows: $INSIGHT_ROWS"
echo "$OUT"
