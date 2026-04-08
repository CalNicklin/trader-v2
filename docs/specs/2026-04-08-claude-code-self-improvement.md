# Claude Code Self-Improvement Agent

**Date:** 2026-04-08
**Status:** Approved

## Problem

The current self-improvement pipeline calls the Anthropic API with a prompt containing the performance landscape JSON. The LLM has no visibility into the actual codebase — it halluccinates file paths, can only edit one file at a time, can't run tests, and can't explore how modules connect. The result: proposals that target non-existent files and blind single-file rewrites.

## Solution

Replace the API-based self-improvement pipeline with a Claude Code GitHub Action. The agent has full codebase access via tool use (read, search, edit, run tests) and SSH access to the production VPS for querying live trading data.

Evolution (strategy parameter mutations) stays as-is — the existing VPS job continues to handle that.

## Architecture

### Trigger Flow

1. Existing `self_improvement` job in `cron.ts` (Sunday 19:00 UK) fires
2. Instead of calling `runSelfImprovementCycle()`, the job runs `gh workflow dispatch` to trigger the GitHub Actions workflow
3. The GitHub Action runs `anthropics/claude-code-action@v1` with Opus, SSH credentials, and a prompt
4. The agent SSHes into the VPS to gather production data, explores the codebase, makes changes, runs tests, and commits
5. The action creates a PR

### GitHub Actions Workflow

Two triggers in a single workflow file (`.github/workflows/claude.yml`):

- **`workflow_dispatch`** — triggered by the VPS scheduler job for automated cycles
- **`issue_comment` + `pull_request_review_comment`** — responds to `@claude` mentions for conversational interaction on PRs and issues

### SSH Access

The VPS SSH private key is stored as a GitHub secret (`VPS_SSH_KEY`). A setup step in the workflow writes it to `~/.ssh/id_ed25519` and adds the VPS host to `known_hosts`. The agent can then `ssh deploy@<host>` to run commands on the VPS.

### Data Gathering

A new script `src/scripts/dump-landscape.ts` runs on the VPS via SSH. It outputs structured JSON containing:

- **Performance landscape** — all strategies with metrics (Sharpe, win rate, expectancy, drawdown, consistency)
- **Trade insights** — recent observations with `suggestedAction`, `confidence`, and `ledToImprovement` status
- **Learning loop metrics** — hit rate of suggestions that led to improvements, unacted-on high-confidence insights
- **Recent trades** — last 20 trades per strategy with P&L and reasoning
- **Evolution history** — recent mutations, which succeeded/failed, rejection reasons
- **Missed opportunities** — recent missed opportunity observations

The agent reads this JSON output and uses it to inform its decisions.

### Agent Prompt

```
You are the self-improvement agent for a live trading system. Your job is to review production performance data and make code improvements that will improve trading outcomes. You have full access to the codebase and can change any file. All changes go through PR review.

To gather production data, SSH into the VPS:
  ssh deploy@$VPS_HOST "cd /opt/trader-v2 && /home/deploy/.bun/bin/bun src/scripts/dump-landscape.ts"

This gives you strategy performance, trade insights, suggested actions, and learning loop metrics.

Read CLAUDE.md for project conventions. Read specs in docs/specs/ for design context. Run bun test --preload ./tests/preload.ts before committing.

Focus areas:
- Strategies with low Sharpe or high drawdown — look at their signal logic
- High-confidence insights that haven't led to improvements (ledToImprovement is null) — these are unacted-on opportunities
- Patterns in missed opportunities — what signals could have caught them
- Evolution proposals rejected by the validator — are constraints too tight?
- Prompt quality — are the LLM prompts for trade review, evolution, dispatch producing good outputs?
- Cost efficiency — are we spending tokens wisely?
```

### Conversational Interaction

- **On PRs**: `@claude` in PR comments to discuss changes, request revisions, ask for explanations
- **On issues**: `@claude` to kick off targeted investigations (e.g. "investigate why strategy X has declining Sharpe")
- The Claude GitHub App handles this automatically via the `issue_comment` trigger

## Files Changed

| File | Change |
|------|--------|
| `.github/workflows/claude.yml` | **New** — Claude Code action with `workflow_dispatch` + comment triggers |
| `src/scripts/dump-landscape.ts` | **New** — dumps performance landscape, insights, trades, evolution history as JSON |
| `src/scheduler/self-improve-job.ts` | Replace `runSelfImprovementCycle()` with `gh workflow dispatch` |
| `src/self-improve/proposer.ts` | **Delete** — replaced by Claude Code agent |
| `src/self-improve/code-generator.ts` | **Delete** — replaced by Claude Code agent |
| `src/self-improve/github.ts` | **Delete** — replaced by Claude Code agent |
| `src/self-improve/types.ts` | **Delete** — no longer needed |
| `tests/self-improve/proposer.test.ts` | **Delete** — old tests |
| `src/evals/self-improve/` | **Delete** — old eval suite |

## Secrets Required

| Secret | Value |
|--------|-------|
| `ANTHROPIC_API_KEY` | Already set in repo |
| `VPS_SSH_KEY` | VPS SSH private key (ed25519) |
| `VPS_HOST` | VPS hostname/IP |

## What Stays

- **Evolution pipeline** — `src/evolution/` unchanged, continues as VPS job
- **Budget guard** — the GitHub Action has its own cost controls via `--max-turns`
- **Learning loop** — trade review, pattern analysis, insights all continue feeding data
- **`improvementProposals` table** — the VPS trigger job can log that a cycle was dispatched; PR tracking moves to GitHub itself
