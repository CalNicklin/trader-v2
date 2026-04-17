---
description: Spawn a 5-analyst team to review learning-loop insights and propose prioritised P&L improvements
allowed-tools: Bash(./scripts/pull-insight-snapshot.sh:*), Bash(git:*), Bash(date:*), Read, Write, Edit, Glob, Grep
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
