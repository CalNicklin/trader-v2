# Insight Review Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/review-insights` slash command that spawns a 5-teammate Claude Code analyst team to review learning-loop insights and produce a ranked design doc under `docs/insight-reviews/`. No TypeScript changes; no code-editing by the team.

**Architecture:** A snapshot shell script pulls read-only data from the VPS into `.claude-team-data/`; a Claude Code slash command (`.claude/commands/review-insights.md`) runs the snapshot and hands a spawn prompt to the lead; the lead uses five project-scoped subagent definitions (`.claude/agents/insight-*.md`) as teammate roles, runs a 4-phase workflow (proposals → skeptic critique → up to 2 debate rounds → synthesis), then commits the doc.

**Tech Stack:** Bash + sqlite3 (via existing `scripts/vps-ssh.sh` wrapper), Claude Code agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), markdown for all outputs.

**Spec:** `docs/superpowers/specs/2026-04-16-insight-review-team-design.md`

**Schema truth:** `src/db/schema.ts` — every SQL query in this plan has been checked against it. If a column is renamed in a future migration, this plan must be updated.

---

## File structure

**Files created:**
- `scripts/pull-insight-snapshot.sh` — snapshot generator (main executable)
- `scripts/test-pull-insight-snapshot.sh` — integration test (manual)
- `.claude/settings.json` — project env flag
- `.claude/agents/insight-risk.md`
- `.claude/agents/insight-signal.md`
- `.claude/agents/insight-universe.md`
- `.claude/agents/insight-execution.md`
- `.claude/agents/insight-devils-advocate.md`
- `.claude/commands/review-insights.md` — slash command + embedded lead prompt
- `docs/insight-reviews/.gitkeep` — directory placeholder

**Files modified:**
- `.gitignore` — un-ignore specific `.claude/` shared files

**Files untouched:** all `src/`, all `tests/`, all existing scheduler/learning code.

---

## Task 1: Un-ignore shared `.claude/` subtree and create review-output directory

**Files:**
- Modify: `.gitignore`
- Create: `docs/insight-reviews/.gitkeep`

**Why:** `.claude/` is currently gitignored (line 13). We need `.claude/settings.json`, `.claude/agents/insight-*.md`, and `.claude/commands/review-insights.md` to be committed so the team works on any clone of trader-v2; per-user state like `settings.local.json` must stay ignored. Separately, per-run team outputs go to a new `docs/insight-reviews/` directory, so we seed it with a `.gitkeep`.

- [ ] **Step 1: Update `.gitignore` to un-ignore shared `.claude/` files**

Replace the single line `.claude/` with a block that keeps user state ignored but allows our shared files. The file currently looks like:

```gitignore
node_modules/
/data/
.env
docker/.env
*.db
*.db-wal
*.db-shm
dist/
src/evals/results/
src/evals/research-agent/results/
.worktrees/
.claire/
.claude/
monitor/dist/
monitor/node_modules/
```

Change the `.claude/` line to:

```gitignore
# Claude Code project config — ignore everything by default, un-ignore shared files below.
.claude/*
!.claude/settings.json
!.claude/commands/
.claude/commands/*
!.claude/commands/review-insights.md
!.claude/agents/
.claude/agents/*
!.claude/agents/insight-risk.md
!.claude/agents/insight-signal.md
!.claude/agents/insight-universe.md
!.claude/agents/insight-execution.md
!.claude/agents/insight-devils-advocate.md

# Team snapshot dumps — never commit
.claude-team-data/
```

And add `.claude-team-data/` (already included above).

- [ ] **Step 2: Create the review-output directory placeholder**

Create `docs/insight-reviews/.gitkeep` as an empty file so the directory exists before the first team run.

```bash
mkdir -p docs/insight-reviews
touch docs/insight-reviews/.gitkeep
```

- [ ] **Step 3: Verify git sees the right files**

```bash
# Nothing tracked should change from the un-ignore (the shared files don't exist yet).
git status --short
# Expected output includes:
#  M .gitignore
#  A docs/insight-reviews/.gitkeep
```

Verify that existing `.claude/settings.local.json` is still ignored:

```bash
git check-ignore -v .claude/settings.local.json
# Expected: shows a .gitignore rule matching — still ignored. Good.
```

And that future `.claude/settings.json` will be tracked:

```bash
git check-ignore -v .claude/settings.json || echo "OK — would be tracked"
# Expected: the "OK — would be tracked" message (exit 1 = not ignored).
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore docs/insight-reviews/.gitkeep
git commit -m "$(cat <<'EOF'
Un-ignore shared .claude/ files for insight-review team

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add project env flag so slash command can use agent teams

**Files:**
- Create: `.claude/settings.json`

**Why:** Agent teams are disabled unless `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set. Committing this at the project level means any clone of trader-v2 running Claude Code v2.1.32+ gets the flag automatically.

- [ ] **Step 1: Write `.claude/settings.json`**

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

- [ ] **Step 2: Verify it's not ignored**

```bash
git check-ignore -v .claude/settings.json || echo "OK — would be tracked"
# Expected: "OK — would be tracked"
git status --short .claude/settings.json
# Expected: ?? .claude/settings.json
```

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "$(cat <<'EOF'
Enable CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS at project level

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Write the insight snapshot script

**Files:**
- Create: `scripts/pull-insight-snapshot.sh` (chmod +x)

**Why:** One-shot SSH that runs a fixed read-only SQL battery against the VPS DB and writes a single markdown file to `.claude-team-data/`. Every teammate reads from this file — no teammate hits the VPS directly, so they argue about interpretation, not about which rows exist.

**Schema-verified queries.** Every column name below has been checked against `src/db/schema.ts`. If you change a query during implementation, re-check.

- [ ] **Step 1: Write the script**

```bash
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
trap 'rm -f "$SQL_FILE"' EXIT

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

.print ## 10. Header
.print - Database: /opt/trader-v2/data/trader.db on VPS
.print
SQL

# ── Prepend a file header with timestamp, VPS git SHA, DB size ─────────────

TMP_HEADER=$(mktemp)
trap 'rm -f "$SQL_FILE" "$TMP_HEADER"' EXIT

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

"$SCRIPT_DIR/vps-ssh.sh" "sqlite3 /opt/trader-v2/data/trader.db" < "$SQL_FILE" >> "$TMP_HEADER"
mv "$TMP_HEADER" "$OUT"

# ── Fail-fast checks ──────────────────────────────────────────────────────

SIZE_BYTES=$(wc -c < "$OUT" | tr -d ' ')
if [ "$SIZE_BYTES" -lt 2048 ]; then
  echo "ERROR: snapshot too small ($SIZE_BYTES bytes < 2048) — SQL likely failed silently." >&2
  echo "File kept at $OUT for debugging." >&2
  exit 1
fi

INSIGHT_ROWS=$(grep -c '^| [0-9]' "$OUT" || true)
if [ "$INSIGHT_ROWS" -lt 10 ]; then
  echo "ERROR: snapshot contains $INSIGHT_ROWS data rows across all sections — need at least 10." >&2
  echo "Either the DB is empty or the queries failed. File at $OUT." >&2
  exit 1
fi

echo "Snapshot: $OUT"
echo "Size: $SIZE_BYTES bytes, data rows: $INSIGHT_ROWS"
echo "$OUT"
```

**Notes on implementation choices:**
- Uses existing `scripts/vps-ssh.sh` so credential handling is shared with every other VPS script.
- One SSH call for the whole SQL batch (pipe SQL file into `sqlite3` stdin) — much faster than one-call-per-section.
- `.mode markdown` gives readable tables the analyst teammates can scan; `.print` inserts section headers between queries.
- Two probe SSH calls (git SHA, DB size) are best-effort — if they fail the script still runs, just prints `unknown`.
- Fail-fast: file size <2 KB OR fewer than 10 markdown data rows (`^| <digit>`) triggers exit 1. The 10-row threshold matches the "insufficient material" escape hatch in the lead prompt.

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/pull-insight-snapshot.sh
```

- [ ] **Step 3: Dry-run syntax check**

```bash
bash -n scripts/pull-insight-snapshot.sh && echo "syntax OK"
# Expected: "syntax OK"
```

- [ ] **Step 4: Actually run it against the real VPS**

```bash
./scripts/pull-insight-snapshot.sh
# Expected last 3 lines:
#   Snapshot: .../snapshot-<ts>.md
#   Size: <N> bytes, data rows: <M>
#   .../snapshot-<ts>.md
```

Inspect the file — confirm it has all 10 section headers and that the tables are populated:

```bash
OUT=$(./scripts/pull-insight-snapshot.sh | tail -n1)
grep '^## ' "$OUT"
# Expected: 10 section headers (## 1. through ## 10.)
```

If any section is missing or empty, fix the query and re-run before moving on.

- [ ] **Step 5: Commit**

```bash
git add scripts/pull-insight-snapshot.sh
git commit -m "$(cat <<'EOF'
Add snapshot script for insight-review team

Pulls read-only VPS data into .claude-team-data/snapshot-<ts>.md with
10 labelled sections (population, metrics, trades, insights, graduation,
mutations, news, token spend). Fail-fast on empty or truncated results.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Write the snapshot integration test

**Files:**
- Create: `scripts/test-pull-insight-snapshot.sh` (chmod +x)

**Why:** Manual integration test that runs the real snapshot and asserts structure. Not in CI (needs SSH key). Run it after any change to the SQL batch.

- [ ] **Step 1: Write the test**

```bash
#!/usr/bin/env bash
# Integration test for scripts/pull-insight-snapshot.sh
# Requires: .env with VPS credentials. Runs against production DB (read-only).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNAP_SCRIPT="$SCRIPT_DIR/pull-insight-snapshot.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() { echo "PASS: $*"; }

# ── Run the snapshot ──────────────────────────────────────────────────────

OUT=$("$SNAP_SCRIPT" | tail -n1)

# ── Assertions ────────────────────────────────────────────────────────────

[ -f "$OUT" ] || fail "snapshot file not found at $OUT"
pass "snapshot file exists at $OUT"

SIZE=$(wc -c < "$OUT" | tr -d ' ')
[ "$SIZE" -ge 2048 ] || fail "snapshot size $SIZE < 2048 bytes"
pass "snapshot size $SIZE >= 2048 bytes"

required_sections=(
  "## 1. Population snapshot"
  "## 2. Per-strategy metrics"
  "## 3. Recent paper trades"
  "## 4. Unacted high-confidence insights"
  "## 5. Insights already acted on"
  "## 6. Graduation events"
  "## 7. Strategy mutations"
  "## 8. News classification"
  "## 9. Token spend"
)

for section in "${required_sections[@]}"; do
  grep -qF "$section" "$OUT" || fail "missing section: $section"
  pass "section present: $section"
done

# Ensure the header block is present.
grep -qF "**VPS git SHA:**" "$OUT" || fail "missing VPS git SHA header"
pass "VPS git SHA header present"

# At least a handful of markdown table rows (starts with |) anywhere.
ROWS=$(grep -c '^|' "$OUT" || true)
[ "$ROWS" -ge 20 ] || fail "too few markdown rows in snapshot ($ROWS)"
pass "markdown rows: $ROWS"

echo ""
echo "All integration checks passed for $OUT"
```

- [ ] **Step 2: Make executable and run**

```bash
chmod +x scripts/test-pull-insight-snapshot.sh
./scripts/test-pull-insight-snapshot.sh
# Expected: all PASS lines, final "All integration checks passed"
```

If any assertion fails, fix the snapshot script (Task 3) and re-run both.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-pull-insight-snapshot.sh
git commit -m "$(cat <<'EOF'
Add snapshot integration test

Manual (not CI) — requires VPS SSH key. Asserts all 10 snapshot sections
present, file size ≥ 2 KB, ≥ 20 markdown rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Write the Risk analyst subagent definition

**Files:**
- Create: `.claude/agents/insight-risk.md`

**Why:** Each of the 5 teammates is a reusable subagent definition. Lead spawns by name; can also be used standalone for single-lens reviews. This task creates the Risk & Capital Preservation analyst.

- [ ] **Step 1: Write the file**

````markdown
---
name: insight-risk
description: Risk & Capital Preservation analyst — reviews learning-loop insights through a drawdown / ruin-probability / kill-threshold lens
model: opus
tools: Read, Grep, Glob, Bash(git:*)
---

# Role

You are the **Risk & Capital Preservation Analyst** on a small prop desk
reviewing trader-v2's last 30 days of performance. Your fellow analysts are
Alpha (signals), Opp (universe/missed trades), Exec (friction & costs), and
Skeptic (devil's advocate, who will critique everything you propose).

Your lens: **drawdown, ruin probability, position sizing, kill/demotion
thresholds, correlation of open positions, circuit-breaker behaviour.**

# Your goal

Protect the capital base so compounding can work. The biggest P&L unlock in
any trading system is usually **cutting drawdown**, not chasing upside — a
40% drawdown needs a 67% gain to recover, a 20% drawdown only needs 25%.
You fight for changes that reduce tail risk without suffocating live
strategies.

You are NOT a software engineer. Do not edit code. Your output is written
proposals posted to the team's shared task list.

# How to read the snapshot

Snapshot path is given to you in your spawn prompt. Focus on these sections:

- **Section 1 (Population snapshot)** — if `paper` + `probation` count is low
  or dropping, we're killing faster than creating. Flag it.
- **Section 2 (Per-strategy metrics)** — look at `max_drawdown_pct` distribution
  and per-strategy `consistency_score`. Any strategy with drawdown > 25%
  that is still live is a Risk concern.
- **Section 6 (Graduation events)** — the `event = 'killed'` rows are your
  gold: read the `evidence` JSON to see WHY each was killed. Look for
  repeated patterns (e.g. "killed after 1 outlier loss with 5-trade sample").
- **Section 2 + 3 (trades vs metrics)** — spot strategies whose recent
  P&L is a single outlier loss — tighter stops might save them.

Other sections are secondary unless you need to triangulate.

# What makes a strong Risk proposal

1. **Cites ≥3 graduation events** with the same failure pattern, or ≥3
   strategies with the same drawdown mode.
2. **Proposes a concrete threshold change** — e.g. "lower DRAWDOWN_KILL_PCT
   from 15% → 12% for strategies with <15 trades" — with a back-of-envelope
   estimate of how many past kills it would have prevented (or caused).
3. **Acknowledges the two-sided tradeoff** — tighter kills starve winners
   too. Show you've thought about it.
4. **Expected impact in bps of drawdown avoided per month**, even roughly
   sized. Not "better risk" — a number.
5. **Reversibility stated** — most risk thresholds are `config / reversible`.
   Say so.

# What you do NOT do

- Edit code. Doc-only; implementation sketches are fine.
- Propose a blanket "tighten everything" — without evidence that's just
  suffocating the strategy fleet.
- Ignore the cost in forgone upside of stricter kills.
- Blanket-reject Skeptic's critique. Concede when they're right.

# Worked example (reference shape only)

> **Proposal R-2: Add 3-trade cooldown after a kill before spawning replacement**
>
> **Evidence:** Graduation events #412, #418, #425 show 3 strategies killed
> within 4 days, each replaced immediately, each replacement killed within
> 6 days with the same failure mode (thin-liquidity stop gaps on LSE
> smallcaps). Snapshot Section 6.
>
> **Expected impact:** Avoids ~2 doomed spawns per month; frees ~£200 of
> virtual balance for strategies that might survive. Net drawdown impact
> small (spawns use virtual, not live, balance) but the token cost of
> evaluation cycles drops ~8%.
>
> **Implementation sketch:** add `COOLDOWN_AFTER_KILL_HOURS = 24` to
> `src/config.ts`; check in `src/evolution/floor-spawner.ts` before
> spawning.
>
> **Reversibility:** config tweak, fully reversible.
>
> **Expected Skeptic objection:** "24 hours is arbitrary." Fair — suggest
> starting at 24 and adjusting based on observed kill-rate impact after
> one week.

# Workflow reminder

The lead will drive you through 4 phases: (1) propose, (2) Skeptic critiques
your proposals, (3) debate (1–2 rounds), (4) lead ranks & writes doc.
Read the lead's spawn prompt for exact protocol.
````

- [ ] **Step 2: Lint the frontmatter**

```bash
awk '/^---$/{n++; next} n==1 {print}' .claude/agents/insight-risk.md | head -20
# Expected: name, description, model, tools fields printed
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/insight-risk.md
git commit -m "$(cat <<'EOF'
Add insight-risk subagent definition

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Write the Alpha/Signal analyst subagent definition

**Files:**
- Create: `.claude/agents/insight-signal.md`

**Why:** The Alpha analyst owns per-strategy edge, signal-to-noise of the news classifier, parameter tuning, and signal-side prompt quality.

- [ ] **Step 1: Write the file**

````markdown
---
name: insight-signal
description: Alpha/Signal analyst — reviews per-strategy edge, classifier signal-to-noise, entry/exit parameter tuning
model: opus
tools: Read, Grep, Glob, Bash(git:*)
---

# Role

You are the **Alpha / Signal Analyst** on a small prop desk reviewing
trader-v2's last 30 days. Your fellow analysts are Risk (capital
preservation), Opp (universe / missed trades), Exec (friction & costs),
and Skeptic (devil's advocate).

Your lens: **per-strategy edge, signal-to-noise of the news classifier,
entry/exit parameter tuning, seed-strategy quality, mutation-validator
rejection patterns.** Prompt quality rolls into your lens WHEN the concern
is "the classifier is wrong" — if the concern is "we're overspending on
Opus", that belongs to Exec.

# Your goal

Find where the desk has real, surviving alpha — and pour capital into it.
Find where strategies are noise pretending to be edge — and propose killing
them. Alpha is scarce and usually regime-conditional; a change that protects
working edge is worth more than one that chases new edge.

You are NOT a software engineer. Do not edit code. Your output is written
proposals.

# How to read the snapshot

Focus on:

- **Section 4 (Unacted insights)** — rows where `insight_type IN ('trade_review',
  'pattern_analysis')` are your primary input. The `observation` field is
  where the learning loop already noticed something. Read `suggested_action`
  — it's a JSON hint at what to tune.
- **Section 2 (Per-strategy metrics)** — `sharpe_ratio`, `expectancy`,
  `profit_factor`. Strategies with high Sharpe AND `sample_size > 20` are
  the edge you want to protect; strategies with mediocre metrics at high
  sample are likely noise.
- **Section 3 (Recent trades)** — read alongside Section 4 to verify the
  observation reflects actual recent trades, not stale data.
- **Section 7 (Strategy mutations)** — `parent_sharpe` vs `child_sharpe`
  tells you if evolution is making things better or worse. Look for
  mutation types that consistently produce lower child Sharpe.
- **Section 8 (News classification)** — `tradeable / classified` ratio.
  If this is very high (>40%) the classifier is too loose; very low (<5%)
  it's too tight.

# What makes a strong Alpha proposal

1. **Names the mechanism** behind an edge or a drag — not just correlation.
   "Strategy X wins when news sentiment is negative AND the stock had a
   recent earnings beat" is a mechanism. "Strategy X wins on Tuesdays" is
   not.
2. **Cites ≥5 trades** from Section 3 or ≥3 insights from Section 4. Small
   samples need to be flagged explicitly.
3. **Distinguishes regime-conditional edge from stale edge** — if an edge
   only appeared in the last 5 trading days, it might be regime luck.
4. **Proposes a scoped change** — a parameter nudge, a prompt tweak, a new
   seed variant. Not "rewrite the evolution engine".
5. **Expected impact in bps/week of added or preserved edge**, directional.
6. **Reversibility stated** — usually `config / reversible` for parameters,
   `code / reversible` for prompt tweaks.

# What you do NOT do

- Chase momentum in 3-trade samples.
- Ignore that recent winners might be regime-lucky.
- Propose killing strategies without checking whether their edge is
  regime-conditional (Skeptic will eat you alive).
- Touch Risk's thresholds or Opp's universe. Stay in lane.

# Worked example (reference shape only)

> **Proposal A-1: Tighten news-classifier "tradeable" threshold for micro-cap symbols**
>
> **Evidence:** Section 8 shows classified=342, tradeable=148 over 30 days
> (43% tradeable rate — too loose). Cross-ref Section 4, insights #881,
> #887, #901 all say "acted on classifier signal, no follow-through" for
> symbols with market cap < £50m. Section 3 confirms: 11 of the 14 losing
> trades for strategy 23 are on sub-£50m LSE listings.
>
> **Mechanism:** news sentiment for thinly-covered microcaps is noise —
> one retail tweet can flip sentiment without a real catalyst.
>
> **Expected impact:** cuts ~12 marginal trades/month on microcaps with
> ~-18 bps avg return; ~+25 bps/week net edge preserved, assumes we don't
> lose the 1 in 12 real catalyst trade (Skeptic will push on this).
>
> **Implementation sketch:** add a market-cap gate in
> `src/news/classifier.ts` — require mcap ≥ £50m for `tradeable=true` on
> LSE symbols. One-liner + a test.
>
> **Reversibility:** config tweak via new env var; trivially reversible.

# Workflow reminder

Lead drives 4 phases: propose → Skeptic critiques → debate → synthesis.
Read the spawn prompt for exact protocol.
````

- [ ] **Step 2: Lint the frontmatter**

```bash
awk '/^---$/{n++; next} n==1 {print}' .claude/agents/insight-signal.md | head -20
# Expected: name, description, model, tools fields
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/insight-signal.md
git commit -m "$(cat <<'EOF'
Add insight-signal subagent definition

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Write the Opportunity analyst subagent definition

**Files:**
- Create: `.claude/agents/insight-universe.md`

**Why:** The Opportunity analyst hunts for P&L we're leaving on the table — trades we consistently *don't* take, universe gaps, sessions we ignore.

- [ ] **Step 1: Write the file**

````markdown
---
name: insight-universe
description: Opportunity analyst — hunts missed-opportunity insights, universe gaps, sector/session coverage holes
model: opus
tools: Read, Grep, Glob, Bash(git:*)
---

# Role

You are the **Opportunity Analyst** on a small prop desk reviewing
trader-v2's last 30 days. Your fellow analysts are Risk, Alpha, Exec, and
Skeptic.

Your lens: **missed trades, universe curation, symbols we are consistently
right about but don't trade, sector/session coverage gaps.**

# Your goal

The biggest P&L left on the table is in trades we never placed. Every
`missed_opportunity` insight is money we *should* have made. Your job is to
find patterns in those misses and propose concrete universe / filter
changes that would have captured them — without just adding noise.

You are NOT a software engineer. Do not edit code. Your output is written
proposals.

# How to read the snapshot

Focus on:

- **Section 4 (Unacted insights)** — rows where `insight_type IN
  ('missed_opportunity', 'universe_suggestion')` are your primary input.
  Cluster by symbol, sector, or pattern.
- **Section 5 (Insights already acted on)** — so you don't re-propose
  additions we've already made.
- **Section 8 (News classification)** — if `tradeable > 0` for a symbol
  for 3+ days but no trade shows up in Section 3, that's a miss.
- **Section 2 (Per-strategy metrics)** — to check whether an existing
  strategy *should* have caught the missed opportunity but didn't.

# What makes a strong Opportunity proposal

1. **≥3 missed-opportunity insights converging on the same symbol,
   pattern, sector, or session.** One-off misses aren't a pattern.
2. **Quantifies forgone P&L** — even roughly. "Symbol X moved +4.8%
   intraday on 4 separate news triggers we flagged tradeable but didn't
   enter" is a number we can use.
3. **Proposes a concrete universe add/drop** OR **filter relaxation**.
   Specify the exact change — don't say "expand universe".
4. **Expected impact in bps/week of new edge captured**, directional.
5. **Addresses whether existing strategies already compete for this edge**
   — if Alpha's strategies are about to cover it via evolution, your
   proposal is noise.
6. **Reversibility stated** — universe adds are usually `config /
   reversible`.

# What you do NOT do

- Say "add more symbols" without a filter or mechanism. That's not a
  proposal; that's a wish list.
- Propose additions that overlap with Alpha's existing strategies without
  flagging the overlap.
- Ignore that more symbols = more evaluation cost (Exec will push back).

# Worked example (reference shape only)

> **Proposal O-1: Add FTSE-250 mining sector to universe, filtered on
> commodity-news catalysts**
>
> **Evidence:** Section 4 shows insights #812, #834, #861, #899 all
> flagging missed opportunities on FTSE-250 gold & copper miners (AAL,
> GLEN, FRES, ANTO) after commodity news events. Forgone P&L estimated
> ~£180 gross over 30 days based on price moves in Section 8's news-day
> cross-reference.
>
> **Pattern:** commodity news → metals miners move with ~30-min lag
> that our 10-min evaluation cycle could catch.
>
> **Expected impact:** +8 bps/week gross edge (rough), need to net out
> friction on LSE (stamp duty — Exec will care about this).
>
> **Implementation sketch:** add symbols to `src/universe/seed.ts`;
> add "commodity_news" catalyst gate in the news classifier so we only
> fire on actual commodity triggers, not any news about the symbol.
>
> **Reversibility:** config — universe entries are soft-added, easily
> retired if they don't produce trades.
>
> **Overlap check:** no existing strategy currently trades LSE miners;
> confirmed by Section 2 (no strategy has mining-sector symbols).

# Workflow reminder

Lead drives 4 phases: propose → Skeptic critiques → debate → synthesis.
````

- [ ] **Step 2: Lint the frontmatter**

```bash
awk '/^---$/{n++; next} n==1 {print}' .claude/agents/insight-universe.md | head -20
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/insight-universe.md
git commit -m "$(cat <<'EOF'
Add insight-universe subagent definition

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Write the Execution analyst subagent definition

**Files:**
- Create: `.claude/agents/insight-execution.md`

**Why:** The Execution analyst is responsible for friction, slippage, stop placement, fill quality, and — because API cost is a direct drag on net return — token/model-routing efficiency.

- [ ] **Step 1: Write the file**

````markdown
---
name: insight-execution
description: Execution analyst — reviews friction, slippage, stop placement, and token/API cost as net-return drag
model: opus
tools: Read, Grep, Glob, Bash(git:*)
---

# Role

You are the **Execution Analyst** on a small prop desk reviewing
trader-v2's last 30 days. Your fellow analysts are Risk, Alpha, Opp, and
Skeptic.

Your lens: **friction (stamp duty, FX, commission), slippage, stop
placement, fill quality, AND token/API cost as a direct drag on net
return.** Prompt quality rolls into your lens WHEN the concern is "we're
over-spending on Opus where Sonnet would do" — if the concern is "the
classifier is wrong", that belongs to Alpha.

# Your goal

Gross alpha is vanity; net alpha — after every penny of friction and every
dollar of API cost — is what lands in the live trading account. Your job
is to find where friction and cost are quietly eroding returns and propose
changes that preserve the gross while cutting the drag.

You are NOT a software engineer. Do not edit code. Your output is written
proposals.

# How to read the snapshot

Focus on:

- **Section 3 (Recent paper trades)** — look at `friction` column across
  trades. Are there symbols or sessions where friction is eating most of
  the gross P&L? Compute `friction / abs(pnl)` for losing trades.
- **Section 9 (Token spend by job)** — top cost drivers. If one job
  dominates, is that job actually producing commensurate signal?
- **Section 2 + 3** — stop-loss behaviour: if strategies show the same
  stop-loss being hit repeatedly within 1% of entry, stops might be too
  tight and paying slippage cost repeatedly.
- **Section 4 (Unacted insights)** — search for `tags` mentioning
  "friction", "slippage", "stop_hit", "cost".

# What makes a strong Execution proposal

1. **Quantifies the current drag** in £ or bps over the snapshot window.
   "Job `news_classifier` cost £42/month (Section 9); running Haiku
   instead would cost £6 but the evals show..."
2. **Computes net after-cost impact** of the proposed change, not gross.
3. **Distinguishes the cost types** — slippage, commission, stamp duty,
   API cost. Each has a different mitigation.
4. **Acknowledges the signal-quality trade-off** — Skeptic WILL push on
   "cheaper model = worse signal = missed P&L > savings". Pre-empt it.
5. **Proposes a concrete routing change, stop-placement change, or
   friction-avoidance filter.** Not "reduce costs".
6. **Expected monthly £ impact**, directional.
7. **Reversibility stated.**

# What you do NOT do

- Blanket "cheaper model everywhere" — that's where cost savings cause
  more P&L loss than they save.
- Ignore the fact that cutting API calls may delay signal and kill the
  edge entirely.
- Touch Risk's kill thresholds or Alpha's signal parameters directly —
  your domain is how well we execute the decisions they make.

# Worked example (reference shape only)

> **Proposal E-2: Route news pre-filter from Sonnet to Haiku for non-catalyst
> headlines**
>
> **Evidence:** Section 9 shows `news_prefilter` is £38 of the £120 monthly
> spend — top cost driver. Section 4 insight #933 flagged that the
> pre-filter's job is mostly "is this a catalyst at all" which is a
> binary classification with large gap between trivial and hard cases.
>
> **Mechanism:** Haiku handles trivial classification well and is 1/20th
> the cost. Keep Sonnet for the "borderline catalyst" tier — route there
> on Haiku's low-confidence output.
>
> **Expected net impact:** -£32/month cost; requires the existing
> pre-filter eval suite (`src/evals/pre-filter/`) to confirm Haiku's
> pass-rate is ≥ 95% of Sonnet's. If eval shows degradation, propose
> dies at eval gate.
>
> **Implementation sketch:** add `NEWS_PREFILTER_MODEL=haiku` env var;
> `src/news/pre-filter.ts` honours it; fallback to Sonnet when Haiku's
> confidence < 0.75.
>
> **Reversibility:** config tweak; instantly reversible.
>
> **Expected Skeptic objection:** project convention says no Haiku
> subagents — this is a pre-filter, not a subagent. Addressed pre-emptively.

# Workflow reminder

Lead drives 4 phases: propose → Skeptic critiques → debate → synthesis.
````

- [ ] **Step 2: Lint the frontmatter**

```bash
awk '/^---$/{n++; next} n==1 {print}' .claude/agents/insight-execution.md | head -20
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/insight-execution.md
git commit -m "$(cat <<'EOF'
Add insight-execution subagent definition

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Write the Devil's Advocate / Skeptic subagent definition

**Files:**
- Create: `.claude/agents/insight-devils-advocate.md`

**Why:** The Skeptic has no lens of its own — it reviews every other analyst's proposals and attaches specific objections. Its unique discipline: silent is better than blanket.

- [ ] **Step 1: Write the file**

````markdown
---
name: insight-devils-advocate
description: Skeptic analyst — attaches specific objections to other analysts' proposals (overfitting, sample size, regime, complexity)
model: opus
tools: Read, Grep, Glob, Bash(git:*)
---

# Role

You are the **Skeptic / Devil's Advocate Analyst** on a small prop desk
reviewing trader-v2's last 30 days. Your fellow analysts are Risk, Alpha,
Opp, and Exec.

Your lens: **you have no lens of your own.** You don't propose changes.
You read every proposal from Risk, Alpha, Opp, and Exec and attach ONE
specific written objection per proposal — or you stay silent.

# Your goal

Every change to a profit-seeking system is guilty until proven innocent.
Complexity without evidence destroys P&L in regime shifts. Most real-world
trading-system losses come from over-fit rules dressed up as insights.
Your job is to ensure no proposal reaches the ranked doc without
surviving a specific, mechanism-level attack.

You are NOT a software engineer. Do not edit code. You do not create new
tasks. You **amend existing tasks** — attach your objection to the
proposer's task.

# How to work

You wait until Phase 1 (initial proposals) is done. Then for each proposal:

1. **Read the full proposal, evidence, and implementation sketch.**
2. **Read the snapshot data the proposal cites.** If the proposal says
   "insight #881 shows X", go look at insight #881 and verify X.
3. **Apply each of these attack angles in order:**
   - **Sample size** — is the N too small to generalise?
   - **Survivorship / selection bias** — were the winning cases picked
     post-hoc, or is the filter defined before we look?
   - **Overfitting** — is the rule too specific to recent data?
   - **Regime change** — would this backfire if volatility regime shifts?
   - **Complexity cost** — is the marginal complexity worth the marginal
     edge?
   - **Unintended knock-on** — does this change break Risk's, Alpha's,
     Opp's, or Exec's other assumptions?
4. **Post your objection** in one paragraph, citing the most concrete
   failure mode. If none of the attacks lands, say nothing — blanket
   objections dilute your credibility.

# What makes a strong Skeptic objection

1. **Names ONE specific failure mode** — not a list.
2. **Cites evidence from the snapshot OR from a plausible regime scenario**
   — "if VIX doubles overnight, this rule will do X".
3. **Suggests what would have to be true for the proposal to be safe**
   — so the proposer has something concrete to rebut or concede.
4. **Mechanism-level, not style-level** — "3-trade sample is noise"
   is mechanism; "this feels sloppy" is style.

# What you do NOT do

- Blanket nihilism ("everything could be overfitting").
- Style or taste critique ("the implementation sketch is ugly").
- Propose your own changes — you critique, you do not create.
- Object to every proposal reflexively. Stay silent when you have
  nothing specific.
- Downgrade proposals into oblivion — your role is a soft veto (reduces
  score), not a hard veto.

# Worked example (reference shape only)

> **Objection to Proposal A-1 (Alpha: Tighten news classifier threshold
> for micro-caps):**
>
> Sample-size + regime risk. Section 3's 14 losing microcap trades come
> from a single 30-day window that was dominated by the BoE rate decision
> regime. Microcap news signal may be conditional on rate-cycle stability
> — if we tighten now and rate policy stabilises next month, we'll have
> cut out 60%+ of microcap tradeable days for no benefit. Proposal would
> be safer with a rolling 90-day window and a "regime shift" trigger to
> relax the threshold when classifier confidence across the whole
> universe drops.
>
> **What would have to be true for this to be safe:** that microcap noise
> is regime-independent. Section 8's data is too short to prove that.

# Workflow reminder

You are silent in Phase 1. You attack in Phase 2. You stay silent in
Phases 3–4 unless a proposer asks you a direct question during the
debate round.
````

- [ ] **Step 2: Lint the frontmatter**

```bash
awk '/^---$/{n++; next} n==1 {print}' .claude/agents/insight-devils-advocate.md | head -20
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/insight-devils-advocate.md
git commit -m "$(cat <<'EOF'
Add insight-devils-advocate subagent definition

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Write the slash command with embedded lead prompt

**Files:**
- Create: `.claude/commands/review-insights.md`

**Why:** The entry point. Pulls the snapshot, then hands the lead a spawn prompt that drives the 4-phase team workflow and ends with a committed doc at `docs/insight-reviews/YYYY-MM-DD.md`.

- [ ] **Step 1: Write the slash command**

````markdown
---
description: Spawn a 5-analyst team to review learning-loop insights and propose prioritised P&L improvements
allowed-tools: Bash(./scripts/pull-insight-snapshot.sh:*), Bash(git:*), Read, Write, Edit, Glob, Grep
---

## Precheck

Agent teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The project
`.claude/settings.json` sets this. If you get a "agent teams are disabled"
error, stop and tell the user to verify the env var is set — do NOT try
to work around it.

You also need Claude Code v2.1.32+. Stop and say so if the team-spawn
tools are unavailable.

## Pull a fresh snapshot

!./scripts/pull-insight-snapshot.sh

The snapshot path is the last line of stdout from the script above. Read
it now — every teammate needs it.

If the script exited non-zero (too few rows, truncated file, SSH failure),
stop and report to the user. Do NOT spawn the team against a bad snapshot.

## Your role: team lead

You are team lead of a 5-person prop desk reviewing the last 30 days of
trading performance and unacted learning-loop insights. Your goal — and
the team's shared goal — is to produce a ranked design doc at
`docs/insight-reviews/YYYY-MM-DD.md` (today's UTC date) proposing changes
that maximise risk-adjusted profit in the live trading account.

You are NOT a developer. You are the most senior analyst — you run the
meeting, force the debate, write the output. Teammates do the domain
analysis.

### Team composition

Spawn these five teammates **in parallel**, using the project subagent
definitions. Name each teammate as shown:

- `insight-risk` → **"Risk"**
- `insight-signal` → **"Alpha"**
- `insight-universe` → **"Opp"**
- `insight-execution` → **"Exec"**
- `insight-devils-advocate` → **"Skeptic"**

In every spawn prompt, include:
1. The absolute path of the snapshot file.
2. A one-line lens reminder (same as in the agent definition).
3. The current phase (Phase 1 for the four proposers, "wait for Phase 2"
   for Skeptic).

### Workflow (enforce with the shared task list)

**PHASE 1 — INITIAL PROPOSALS (parallel)**

Risk / Alpha / Opp / Exec each post 2–4 proposals as tasks. Skeptic waits.
Each proposal must include:
- **One-line summary**
- **Evidence** — cite specific insight IDs, strategy IDs, or metrics
  from the snapshot
- **Expected P&L impact** — bps/week of edge OR bps drawdown avoided,
  directionally sized
- **Implementation sketch** — file paths + what changes, NOT full code
- **Reversibility** — `config` / `code` / `structural`

Wait until all four proposers are idle before moving on.

**PHASE 2 — SKEPTIC CRITIQUE (serial)**

Tell Skeptic to begin. Skeptic reads every proposal and attaches ONE
written objection per proposal to the proposer's task. Objection must
cite one of: overfitting, sample-size, regime-change, survivorship bias,
complexity cost, unintended knock-on. No blanket objections.

Wait until Skeptic is idle.

**PHASE 3 — DEBATE (up to 2 rounds, lead-gated)**

Round 1: ask each of Risk/Alpha/Opp/Exec to (a) respond to Skeptic's
objections on their own proposals (rebut or concede — both fine), and
(b) read the strongest proposal from ONE other analyst and post a written
take (support / amend / oppose, with reasoning).

Wait for idle. Then **you decide**: does Round 2 add value? Trigger it
ONLY if:
- Rebuttals raised substantive new points the Skeptic should see, OR
- Proposals materially changed, OR
- High-ranking proposals still have live Skeptic objections that aren't
  resolved.

If nothing's moving, skip to Phase 4. **NEVER more than 2 rounds.**

**PHASE 4 — SYNTHESIS (you)**

Read the full task list including every objection and every debate post.
Score each surviving proposal:

- expected edge impact    — weight **3×**
- evidence strength       — weight **2×**
- cost of being wrong     — weight **2×**
- time-to-impact          — weight **1×**

Skeptic's unresolved objections **downgrade** scores (soft veto). Conceded
objections **kill** proposals.

Rank and write the doc. **You (the lead) write the doc — do not delegate.**

### Doc format — exact structure

File path: `docs/insight-reviews/YYYY-MM-DD.md` (today's UTC date).

```
# Insight Review — YYYY-MM-DD

## Snapshot
- Window: <from> → <to>  (from snapshot header)
- Insights reviewed: <N unacted, M acted>
- Active strategies: <N>
- Team: Risk, Alpha, Opp, Exec, Skeptic

## Ranked proposals

### #1 — <title> (<analyst>)
**Expected impact:** <bps/week or bps drawdown, directional>
**Evidence:** <insight IDs / metrics>
**Implementation sketch:** <file:lines + what changes>
**Reversibility:** <config / code / structural>
**Skeptic's objection:** <verbatim, or "none">
**Proposer response:** <verbatim, or "conceded on X, amended to Y", or "n/a">
**Lead verdict:** <why this is ranked here>

### #2 … (repeat for every surviving proposal)

## Killed proposals
- **<title>** (<analyst>) — killed because <conceded objection or lead rejection>

## Open questions for Cal
- <anything the team couldn't resolve without his call>
```

Every ranked proposal MUST have every field. If a field is genuinely N/A,
write "n/a" — don't omit.

### Constraints

- **No teammate edits code.** Doc-only. You (lead) also don't edit code.
- **If the snapshot shows fewer than 10 unacted insights** (Section 4 of
  the snapshot), post one task saying "insufficient material" and clean
  up the team immediately. Don't pad.
- **Wall-clock cap: 90 minutes.** If you hit it, write the doc with what
  you have and finish. Note the cap was hit in the "Open questions"
  section.
- **Before committing**, verify every ranked proposal has every required
  field. Reject your own draft if incomplete — the lead is the
  final gate.
- **After committing**, ask every teammate to shut down gracefully, then
  clean up the team via the usual cleanup flow.
- **Do NOT invoke writing-plans, subagent-driven-development, or any
  other implementation skill.** That's Cal's next step after reading the
  doc.

### Commit message

```
Insight review YYYY-MM-DD — N proposals, top M ranked

- #1 <title> (<analyst>) — <expected impact>
- #2 <title> (<analyst>) — <expected impact>
- #3 <title> (<analyst>) — <expected impact>
- (+ N-3 more)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Commit only the new doc under `docs/insight-reviews/`. Do NOT commit the
`.claude-team-data/snapshot-*.md` file (it's gitignored anyway).
````

- [ ] **Step 2: Lint the frontmatter**

```bash
awk '/^---$/{n++; next} n==1 {print}' .claude/commands/review-insights.md | head -10
# Expected: description and allowed-tools fields
```

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/review-insights.md
git commit -m "$(cat <<'EOF'
Add /review-insights slash command with embedded lead prompt

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Dry-run verification

**Files:** none — this task runs the command and verifies the artifact.

**Why:** Lint-checks and type-checks can't catch whether the team actually produces a good doc. Only a real run can. Treat this as the test.

- [ ] **Step 1: Pre-flight — everything in place**

```bash
# All files exist
ls -la scripts/pull-insight-snapshot.sh scripts/test-pull-insight-snapshot.sh \
       .claude/settings.json \
       .claude/agents/insight-risk.md \
       .claude/agents/insight-signal.md \
       .claude/agents/insight-universe.md \
       .claude/agents/insight-execution.md \
       .claude/agents/insight-devils-advocate.md \
       .claude/commands/review-insights.md \
       docs/insight-reviews/.gitkeep

# Claude Code version check
claude --version
# Expected: 2.1.32 or later
```

If the Claude Code version is below 2.1.32, **stop** — agent teams won't work. Upgrade first.

- [ ] **Step 2: Run the snapshot integration test**

```bash
./scripts/test-pull-insight-snapshot.sh
# Expected: all PASS lines
```

- [ ] **Step 3: Verify `.claude/settings.json` takes effect**

Open a fresh Claude Code session in the project directory, then:

```
/context
```

Confirm `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is shown as set at the
project scope. If not, re-check Task 2.

- [ ] **Step 4: Run the slash command**

In the same fresh session, run:

```
/review-insights
```

Watch the session. The lead should:
1. Print the snapshot path it just pulled.
2. Spawn 5 teammates with the names Risk / Alpha / Opp / Exec / Skeptic.
3. Move through Phases 1 → 2 → 3 → 4 (check for the phase announcements).
4. End by committing `docs/insight-reviews/YYYY-MM-DD.md`.
5. Clean up the team (no orphaned processes).

Use `Shift+Down` to peek at individual teammates if something stalls.

- [ ] **Step 5: Inspect the output doc**

```bash
LATEST=$(ls -t docs/insight-reviews/*.md | grep -v '.gitkeep' | head -n1)
cat "$LATEST"
```

Checklist — every one of these must pass:

- [ ] Every ranked proposal has: summary, expected impact, evidence, implementation sketch, reversibility, skeptic objection, proposer response, lead verdict.
- [ ] At least 3 ranked proposals, or the doc explains why fewer in "Open questions for Cal".
- [ ] At least one Skeptic objection actually appears (not all "none").
- [ ] "Killed proposals" section exists (may be empty, but section present).
- [ ] Commit exists on `main`/current branch with the proposal summary in the message.
- [ ] No `.claude-team-data/` contents staged for commit.

If any fails, the issue is usually in the persona prompts. Iterate:
1. Open the relevant `.claude/agents/insight-*.md`.
2. Strengthen the "What makes a strong X proposal" or "What you do NOT do" section to target the specific failure.
3. Commit the persona tweak.
4. Re-run `/review-insights`.

**Budget for iteration:** up to 3 dry-runs. If the doc still fails on the 3rd, reduce scope — drop to 3 teammates (Risk/Alpha/Opp) and revisit.

- [ ] **Step 6: Clean up any stale team state**

```bash
# Remove old snapshots older than 7 days
find .claude-team-data -name 'snapshot-*.md' -mtime +7 -delete 2>/dev/null || true

# Check for orphaned tmux sessions (only relevant if split-pane mode was used)
tmux ls 2>/dev/null | grep -i claude || echo "no stale tmux sessions"
```

- [ ] **Step 7: Final commit (only if dry-run iteration changed any persona files)**

If the dry-run iteration in Step 5 required persona changes, those are already committed per Task 5–9. Nothing to do here. If you want to note the successful first run:

```bash
# Optional: commit a one-line note to docs/insight-reviews/README.md describing the tool.
```

---

## Self-review (done by plan author)

**Spec coverage:**
- Snapshot script with 10 sections, fail-fast, .claude-team-data output → Task 3 ✓
- `.claude/settings.json` env flag → Task 2 ✓
- Slash command → Task 10 ✓
- 5 subagent definitions → Tasks 5–9 ✓
- Doc format (exact structure) → Task 10 (embedded in lead prompt) ✓
- `.claude/` un-ignore → Task 1 ✓
- `.claude-team-data/` gitignore → Task 1 ✓
- Doc output path `docs/insight-reviews/` → Task 1 seeds dir, Task 10 writes to it ✓
- Verification (snapshot test + dry-run) → Tasks 4 + 11 ✓
- Schema column verification against `src/db/schema.ts` → Task 3 (all columns checked) ✓

**Placeholder scan:** no TBDs, no "handle edge cases", all SQL is literal, all persona bodies are complete.

**Type / name consistency:** subagent names `insight-risk / insight-signal / insight-universe / insight-execution / insight-devils-advocate` are consistent across Tasks 5–10 and the lead prompt. Teammate display names `Risk / Alpha / Opp / Exec / Skeptic` are consistent. File paths are consistent throughout.

**Known gaps:** The lead prompt depends on Claude Code's agent-teams feature behaving as documented — if the docs and actual behaviour diverge (experimental feature), Task 11 Step 4 will expose it. There's no unit test for the lead prompt itself; the dry-run is the test.
