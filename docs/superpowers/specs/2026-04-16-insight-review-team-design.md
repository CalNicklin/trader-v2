# Insight Review Team — Design

**Date:** 2026-04-16
**Author:** Cal (via brainstorming with Claude)
**Status:** Approved — awaiting implementation plan

## Problem

Trader-v2's learning loop produces `trade_insights` rows (types: `trade_review`,
`pattern_analysis`, `graduation`, `missed_opportunity`, `universe_suggestion`).
The current nightly self-improvement workflow is a single Opus session in
`.github/workflows/claude.yml` that reads all the data, writes code, and opens
PRs end-to-end. It works, but:

- A single agent anchors on the first plausible improvement it finds.
- There's no adversarial pressure against overfitting or complexity creep.
- Priorities are whatever the lone agent personally finds interesting on the
  night it runs — no deliberate multi-lens coverage.

We want a **heavier-weight, on-demand planning instrument** that produces a
ranked design doc — not code — by forcing structured disagreement across four
analyst lenses plus a Skeptic, using Claude Code's experimental agent-teams
feature.

## Non-goals

- **Not** replacing the nightly `claude.yml` self-improvement PR flow. That
  stays as-is.
- **Not** opening PRs. This tool's output is a committed design doc.
- **Not** automating the priority decisions. Cal reads the doc and chooses.
- **Not** a subagents-style single-reporter pattern. The whole point is
  peer-to-peer debate, which requires agent teams, not subagents.
- **Not** scheduled. On-demand only — Cal fires it when he wants a deep review.

## Framing — analysts, not engineers

The team is cast as a small prop-desk meeting. All personas are **financial
analysts maximising risk-adjusted profit in the live trading account**, not software
engineers chasing cleaner code. Rubrics are in P&L terms (expected bps of
edge or drawdown avoided), implementation details second. Code-quality
concerns roll into whichever analyst owns the downstream P&L consequence.

## Architecture

### Pieces

| Path | Purpose | Gitignored? |
|---|---|---|
| `scripts/pull-insight-snapshot.sh` | One-shot snapshot generator | committed |
| `.claude/settings.json` | Adds `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | committed |
| `.claude/commands/review-insights.md` | Slash command + lead spawn prompt | committed |
| `.claude/agents/insight-risk.md` | Risk analyst persona | committed |
| `.claude/agents/insight-signal.md` | Alpha analyst persona | committed |
| `.claude/agents/insight-universe.md` | Opportunity analyst persona | committed |
| `.claude/agents/insight-execution.md` | Execution analyst persona | committed |
| `.claude/agents/insight-devils-advocate.md` | Skeptic persona | committed |
| `.claude-team-data/` | Snapshot dumps | **gitignored** |
| `docs/insight-reviews/YYYY-MM-DD.md` | Team output | committed per run |

### Flow

```
/review-insights
  → snapshot.sh (SSH to VPS, write .claude-team-data/snapshot-<ts>.md)
  → lead reads snapshot
  → lead spawns 4 specialists + Skeptic (by subagent definition, named)
  → Phase 1: specialists post initial proposals (parallel)
  → Phase 2: Skeptic attaches one objection per proposal (serial)
  → Phase 3: 1–2 rounds of debate, lead-gated
  → Phase 4: lead scores, ranks, writes doc, commits, tears team down
```

Token shape: five parallel Opus context windows × 1–2 debate rounds. Heavy —
but fired deliberately, and output is a plan doc, so blast radius is zero.

## Components

### 1. Snapshot script — `scripts/pull-insight-snapshot.sh`

Single SSH session. Runs a fixed battery of read-only queries against
`/opt/trader-v2/data/trader.db`. Writes one markdown file to
`.claude-team-data/snapshot-<YYYYMMDD-HHMMSS>.md`. Prints the path to stdout
(last line) so the slash command can reference it.

**Sections (in order):**

1. **Header** — UTC timestamp, git SHA on VPS, DB size.
2. **Population snapshot** — `SELECT status, COUNT(*) FROM strategies GROUP BY status`.
3. **Per-strategy metrics** — active/probation/paper strategies joined with
   `strategy_metrics`, ordered by Sharpe desc.
4. **Recent trades — last 30 days** — `paper_trades` with symbol, side, qty,
   entry/exit, pnl, friction, hold_days.
5. **Insights — unacted, high-confidence, last 60 days** — `trade_insights`
   where `(led_to_improvement IS NULL OR 0)` AND `confidence >= 0.6`, ordered
   by confidence DESC, LIMIT 200. *Primary input for all four analysts.*
6. **Insights acted-upon, last 30 days** — so the team sees what's already
   been done and doesn't re-propose it.
7. **Graduation events, last 30 days** — who was killed/promoted and why.
8. **Strategy mutations, last 30 days** — what evolution has been trying.
9. **News classification volume & tradeable rate, last 30 days** — daily
   counts of classified vs. tradeable to show classifier calibration.
10. **Token spend, last 30 days, grouped by component** — cost drag per
    caller.

**Exact column names will be verified against `src/db/schema.ts` during plan
writing.** If any column differs, the plan step fixes it.

**Fail-fast conditions (exit 1):**
- SSH connection fails.
- `trade_insights` row count in the snapshot is < 10.
- Snapshot file size < 2 KB.

### 2. Settings — `.claude/settings.json`

Project-scoped, committed, so the slash command works on any machine checking
out trader-v2:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### 3. Slash command — `.claude/commands/review-insights.md`

Project-scoped slash command. Structure:

```md
---
description: Spawn a 5-analyst team to review learning-loop insights and propose prioritised P&L improvements
allowed-tools: Bash(./scripts/pull-insight-snapshot.sh:*), Bash(git:*)
---

## Precheck
Agent teams require CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.
If not set, stop and tell Cal to set it in settings.json.

## Pull fresh snapshot
!./scripts/pull-insight-snapshot.sh

The snapshot path is in the last line above.

## Your role: team lead
<FULL LEAD SPAWN PROMPT — see below>
```

### 4. Lead spawn prompt (embedded in slash command)

````
You are team lead of a 5-person prop desk reviewing the last 30 days of
trading performance and unacted learning-loop insights. Your goal — and
the team's shared goal — is a ranked design doc at
`docs/insight-reviews/YYYY-MM-DD.md` proposing changes that
maximise risk-adjusted profit in the live trading account.

You are NOT a developer. You are the most senior analyst. Teammates do the
domain analysis; you run the meeting, force the debate, write the output.

## Team composition (spawn in parallel)

Use these project subagent definitions, naming each teammate:
  - insight-risk                → "Risk"
  - insight-signal              → "Alpha"
  - insight-universe            → "Opp"
  - insight-execution           → "Exec"
  - insight-devils-advocate     → "Skeptic"

Give each the same snapshot path plus a one-line lens reminder.

## Workflow (enforce with the shared task list)

PHASE 1 — INITIAL PROPOSALS (parallel)
Risk / Alpha / Opp / Exec each post 2–4 proposals. Skeptic waits.
Each proposal must include:
  - one-line summary
  - evidence (cite specific insight IDs, strategy IDs, metrics)
  - expected P&L impact (bps/week edge OR bps drawdown avoided,
    directionally sized)
  - implementation sketch (file paths + what changes, not full code)
  - reversibility (config tweak / code change / structural change)

PHASE 2 — SKEPTIC CRITIQUE (serial)
Skeptic attaches one written objection per proposal. Objection must cite:
overfitting risk, sample-size concern, regime-change exposure,
survivorship bias, or complexity cost. No blanket objections — specific
or silent.

PHASE 3 — DEBATE (up to 2 rounds, lead-gated)
Round 1: each of Risk/Alpha/Opp/Exec reads Skeptic's objections to their
own proposals AND reads the strongest proposal from ONE other analyst.
They post a rebuttal (or concession) plus their take on that other
proposal (support/amend/oppose, with reasoning).
After Round 1, you decide whether Round 2 adds value — trigger it only
if rebuttals raised substantive new points, proposals materially
changed, or Skeptic's objections remain unresolved on proposals that
otherwise rank highly. Never more than 2 rounds.

PHASE 4 — SYNTHESIS (you)
Rank all surviving proposals with this rubric:
  - expected edge impact        (weight 3×)
  - evidence strength           (weight 2×)
  - cost of being wrong         (weight 2×)
  - time-to-impact              (weight 1×)
Skeptic's unresolved objections downgrade scores; conceded objections
kill proposals.

Write doc. Commit it. Clean up team.

## Doc format (exact structure)

```
# Insight Review — YYYY-MM-DD

## Snapshot
- Window: <from> → <to>
- Insights reviewed: <N unacted, M acted>
- Active strategies: <N>
- Team: Risk, Alpha, Opp, Exec, Skeptic

## Ranked proposals

### #1 — <title> (<analyst>)
**Expected impact:** <bps/week or bps drawdown, directional>
**Evidence:** <insight IDs / metrics>
**Implementation sketch:** <file:lines + what changes>
**Reversibility:** <config / code / structural>
**Skeptic's objection:** <verbatim>
**Proposer response:** <verbatim or "conceded on X, amended to Y">
**Lead verdict:** <why this is #1>

### #2 …

## Killed proposals
- <title> — killed because <conceded objection or lead rejection>

## Open questions for Cal
- <anything the team could not resolve without his call>
```

## Constraints

- No teammate edits code. Doc only.
- If snapshot shows < 10 unacted insights, post "insufficient material"
  and clean up immediately. Don't pad.
- Wall-clock cap: 90 minutes. Write doc with what you have and finish.
- Before commit, verify every required field present on every ranked
  proposal.
- After commit: shut down every teammate, then clean up the team.
- Do NOT invoke writing-plans. That's Cal's next step after review.
````

### 5. Subagent definitions

Five files in `.claude/agents/`. Common frontmatter:

```yaml
---
name: insight-<role>
description: <one-liner>
model: opus
tools: Read, Grep, Glob, Bash(git:*)
---
```

Body structure for each: **Role → Goal → How you read the snapshot →
Strong-proposal criteria → Anti-signals → What you do NOT do → Worked
example**. Worked example uses realistic schema references.

**Per-analyst lenses:**

- **`insight-risk`** — drawdown, ruin probability, position sizing,
  kill/demotion thresholds, correlation of open positions, circuit breaker.
  *Strong:* cites ≥3 graduation events with same failure mode; estimates
  past kills avoided. *Anti:* blanket tightening; ignoring impact on
  winners.

- **`insight-signal`** — per-strategy edge, news classifier signal-to-noise,
  entry/exit parameter tuning, seed strategy quality, mutation-validator
  rejection patterns. Prompt quality rolls in *here* when it's about signal
  correctness. *Strong:* names mechanism behind an edge/drag; distinguishes
  regime-conditional from stale edge. *Anti:* momentum-chasing on small
  sample; ignoring regime luck.

- **`insight-universe`** — missed trades, universe curation, sector/session
  coverage gaps. *Strong:* ≥3 missed-opportunity insights on the same
  symbol/pattern; quantifies forgone P&L. *Anti:* "add lots of symbols"
  without attention to contested edge.

- **`insight-execution`** — friction, slippage, stops, fill quality, AND
  token/API cost as P&L drag. Prompt quality rolls in *here* when it's
  about over-spending. *Strong:* computes net after-cost return; monthly £
  impact of proposed change. *Anti:* "reduce all costs"; ignoring signal
  degradation trade-off.

- **`insight-devils-advocate`** — no proposals of its own. Attaches
  objections to other analysts' proposals. *Strong:* cites sample size,
  offers concrete backfire scenario, names preconditions for safety.
  *Anti:* blanket nihilism ("everything could be overfitting");
  style-based critique. *Unique rule:* amends existing tasks, does not
  create new ones.

Subagent definitions are **reusable as standalone subagents** — Cal can
invoke `insight-risk` alone to sanity-check a single proposal without
spinning up the full team.

## Verification

1. **Snapshot script shell test** — runs the script, greps output for every
   required section header, asserts file size ≥ 2 KB. Manual, not in CI
   (needs SSH key).
2. **Subagent-definition lint** — greps each `.claude/agents/insight-*.md`
   for valid YAML frontmatter with `name`, `description`, `model: opus`.
3. **Dry-run the team once** — after all files exist, run `/review-insights`
   against the real VPS, read the produced doc, confirm:
   - every required field present on every ranked proposal
   - at least one Skeptic objection appears
   - team cleanly torn down (no orphaned tmux / processes)
   - iterate persona prompts if doc quality is low; re-run.

## Failure modes accepted

- **Stale snapshot** — Cal re-runs the command manually; no auto-refresh.
- **One teammate errors** — lead spawns a replacement or carries on with 4
  analysts + Skeptic, noting the gap in the doc.
- **Mid-run session death** — no resumption (known agent-teams limitation
  in in-process mode). Re-run from scratch. Documented in the slash
  command.

## Key decisions (rationale trail)

- **On-demand, not scheduled.** Agent teams are experimental with real
  limitations; scheduled unattended runs are unsafe.
- **Doc-only output.** A committed plan doc is a reviewable checkpoint
  before any code moves — keeps existing nightly PR flow as the code path.
- **5 teammates, not 3 or 7.** Docs' sweet spot is 3–5; Skeptic requires
  a floor of 4 real proposers to debate against.
- **Financial-analyst framing.** Code-quality framing quietly redirects
  attention away from P&L, which is the only thing that matters for
  Cal's trading account.
- **Up to 2 debate rounds, lead-gated.** One round often leaves
  high-ranked proposals with live Skeptic objections; a second round is
  valuable when it would materially change the ranking. More than 2 is
  token waste.
- **Skeptic has soft veto (downgrade), not hard veto.** Hard vetos
  collapse teams into producing nothing.
- **Pre-pulled shared snapshot.** If each teammate pulled its own data
  they'd argue about which rows exist instead of what to do about them.

## Open questions (to answer during plan writing)

- Exact column names in the snapshot SQL (verify against
  `src/db/schema.ts`).
- Whether `scripts/pull-insight-snapshot.sh` should reuse the existing
  `scripts/vps-ssh.sh` wrapper (for credential handling) or inline the SSH.
- Whether the `.claude/settings.json` env addition needs to be merged into
  an existing file or created from scratch.
