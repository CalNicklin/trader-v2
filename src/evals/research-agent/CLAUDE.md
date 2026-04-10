# Research Agent Eval Suite

This suite gates any change to `src/news/research-agent.ts`,
`src/news/rss-feeds.ts`, or `src/data/ftse100.ts`.

**Canonical spec:** `docs/specs/2026-04-10-lse-news-signal-fix.md` (Section 4)

## Task categories (20 tasks total)

| ID | Category                         | Count | Blocking? |
|----|----------------------------------|-------|-----------|
| A  | LSE attribution preservation     | 5     | Yes       |
| B  | LSE whitelist compliance         | 5     | Yes       |
| C  | US regression                    | 5     | Yes       |
| D  | Multi-symbol LSE expansion       | 3     | No (tracked) |
| E  | Deprecated-ticker rejection      | 2     | No (tracked) |

Blocking categories (A, B, C) must pass ≥90% across 3 trials before a PR
touching the research agent may merge. Non-blocking categories are tracked
and promoted to blocking once they stabilise.

## Corpus

- `fixtures/lse-corpus.json` — hand-labelled LSE headlines from production
- Refresh via `scripts/export-lse-eval-corpus.ts` (queries prod via SSH)
- After export: hand-label each entry's correct primary symbol before committing

## Adding a task

1. Pick the category that matches the behaviour you are testing.
2. Append a new entry to `tasks.ts` with a unique `id` (e.g. `ra-lse-a-006`).
3. Run the suite locally: `bun src/evals/run.ts research-agent`
4. If you added a new category, update this file and the spec.

## Do NOT

- Do not move a task from non-blocking to blocking without a spec update
- Do not delete regression tasks to make a failing suite pass
- Do not model-label ground truth — human review only
