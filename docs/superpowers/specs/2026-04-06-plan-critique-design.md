# Plan Critique Skill Design

## Overview

A superpowers skill that stress-tests implementation plans through adversarial multi-agent conversation before any code gets written. Two agents — a Critic and a Resolver — debate the plan in rounds until they converge on a solid design or escalate unresolved disagreements to the user.

Inspired by Anthropic's [harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps), which found that separating generation from evaluation produces better results because agents can't honestly evaluate their own work.

## Where It Fits

```
brainstorming → writing-plans → **plan-critique** → subagent-driven-development
```

Inserted after plan writing, before implementation. The plan must exist as a file before this skill is invoked.

## Agents

### Critic

Tears the plan apart. Does NOT propose solutions — only identifies problems.

**What the critic looks for:**

- **Gaps** — what's unspecified that will bite the implementer mid-task?
- **Wrong abstractions** — will this decomposition actually work? Are the file/module boundaries right?
- **Missing edge cases** — error scenarios, race conditions, empty states, boundary conditions
- **Contradictions** — do any tasks conflict with each other or with the spec?
- **Overcomplexity / YAGNI** — is anything being over-engineered for hypothetical future needs?
- **Sequencing issues** — are task dependencies correct? Can tasks actually be implemented in this order?
- **Testability** — can the proposed tests actually verify the behavior? Are there untestable requirements?
- **Spec drift** — does the plan actually implement what the spec says, or has it diverged?

**Critic output format:**

```markdown
# Critique — Round N

## Verdict: ISSUES | PASS | MINOR_ONLY

## Structural Issues
1. [Issue title]
   - **Where:** Task N, Step M (or cross-cutting)
   - **Problem:** [What's wrong]
   - **Severity:** HIGH | MEDIUM
   - **Why it matters:** [What breaks if this isn't addressed]

## Minor Issues (optional)
- [Issue]: [brief description]
```

Verdict meanings:
- `ISSUES` — structural problems found, another round needed
- `PASS` — no structural issues remain, plan is solid
- `MINOR_ONLY` — only cosmetic/stylistic points, not worth another round

### Resolver

Reads the critique and revises the plan. For each issue raised:
- **Acknowledges and fixes** valid points by rewriting the relevant plan sections
- **Pushes back** on invalid points with specific reasoning

The resolver does NOT blindly accept all criticism. It exercises technical judgment.

**Resolver output format:**

```markdown
# Resolution — Round N

## Responses
1. [Issue title from critique]
   - **Action:** FIXED | PUSHED_BACK | PARTIALLY_ADDRESSED
   - **Reasoning:** [Why this action was taken]
   - **Changes:** [What was modified in the plan, if anything]

## Summary of Plan Changes
- [List of substantive changes made to the plan]
```

The resolver also updates the actual plan file with the revisions.

## Loop Mechanics

1. Orchestrator reads the existing plan file
2. Dispatch **Critic** with the full plan text
3. Critic writes critique to `.harness/critique/round-N-critique.md`
4. If verdict is `PASS` or `MINOR_ONLY` → done, proceed to implementation
5. Dispatch **Resolver** with plan + critique
6. Resolver writes resolution to `.harness/critique/round-N-resolution.md` and updates the plan file
7. Repeat from step 2 with the revised plan
8. If round 3 completes and critic still returns `ISSUES` → present remaining disagreements to the user for resolution

**Default max rounds:** 3 (configurable by user)

## Communication

- **File-based artifacts:** Critique reports and resolution responses are written to `.harness/critique/` for auditability. These form a conversation trail showing how the plan evolved.
- **Prompt-based dispatch:** The orchestrator reads agent outputs and injects relevant context into the next agent's prompt. Agents don't read files directly — they receive everything they need in their prompt.
- **Plan updates:** The resolver overwrites the original plan file with revisions. Git history preserves the evolution.

## Convergence

The loop has two termination conditions:

1. **Critic sign-off:** Verdict is `PASS` or `MINOR_ONLY`
2. **Round limit:** After 3 rounds, if the critic still has `ISSUES`, the orchestrator presents the remaining disagreements to the user

On convergence, the skill commits the final revised plan and transitions to the next step (subagent-driven-development or executing-plans).

## What This Skill Does NOT Do

- **No code generation** — purely about plan quality
- **No requirements gathering** — assumes brainstorming is complete and a spec exists
- **No code review** — that happens later in subagent-driven-development
- **No behavioral testing** — there's nothing to run yet

## Integration

**Required prior steps:**
- `superpowers:brainstorming` — produces the spec
- `superpowers:writing-plans` — produces the plan this skill critiques

**Next step after completion:**
- `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`

## Example Flow

```
User invokes plan-critique on docs/superpowers/plans/2026-04-06-feature-x.md

Round 1:
  Critic → ISSUES: 3 structural, 2 minor
    - Task 3 depends on Task 5's output but runs first
    - No error handling for API timeout in Task 2
    - File boundary between service and handler is wrong
  Resolver → Fixes sequencing, adds timeout handling, pushes back on file boundary with reasoning
  Plan file updated

Round 2:
  Critic → ISSUES: 1 structural
    - Resolver's pushback on file boundary is wrong because [specific reason]
  Resolver → Acknowledges, restructures files
  Plan file updated

Round 3:
  Critic → PASS
  Done. Plan committed. Proceed to implementation.
```
