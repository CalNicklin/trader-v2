# LSE News Signal Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the LSE news→trade pipeline so FTSE-100 symbols reliably drive paper trades via a whitelist-aware research agent, expanded UK sources, and eval-gated prompt changes.

**Architecture:** Pin the RSS-matched primary symbol as authoritative, pass the paper-strategy universe to the research agent as a whitelist, expand UK news sources (more RSS feeds + RNS scraper with circuit breaker), seed the FTSE-100 universe from FMP with a committed fallback, add a three-layer false-ticker rejection, and gate all prompt changes on a 20-task eval suite.

**Tech Stack:** Bun + TypeScript (strict), Drizzle ORM on SQLite via `bun:sqlite`, Biome (tab indentation), `@anthropic-ai/sdk`, `rss-parser`, `bun:test` with `tests/preload.ts`.

**Spec:** `docs/specs/2026-04-10-lse-news-signal-fix.md`
**Problem statement:** `docs/plans/2026-04-10-lse-news-signal-gap.md`

---

## Execution Order

Tasks are ordered so each phase is independently shippable. Phases 0 → 4 map directly to the spec's rollout sections.

- **Phase 0** — Agent context docs (Tasks 1–4)
- **Phase 1** — FTSE-100 universe seeding (Tasks 5–9)
- **Phase 2** — RSS/RNS source expansion (Tasks 10–16)
- **Phase 3** — Research-agent refactor + evals (Tasks 17–24)
- **Phase 4** — FMP `isActivelyTrading` guard (Tasks 25–26)

Each task ends with running the three-check gate (`bunx tsc --noEmit`, `bunx biome check src/ tests/`, `bun test --preload ./tests/preload.ts`) before commit. If any check fails, fix it in the same task before moving on.

---

## File Structure

**New files:**
- `src/news/CLAUDE.md` — subsystem guide for the self-improvement agent
- `src/evals/research-agent/CLAUDE.md` — eval-suite guide for agents touching evals
- `src/agents/subsystem-context.ts` — shared runtime prompt context constants
- `src/data/ftse100.ts` — FMP-backed FTSE-100 constituent loader with DB cache
- `src/data/ftse100-fallback.json` — hand-committed safety-net universe
- `src/news/alias-overrides.ts` — hand-maintained nickname alias map
- `src/news/uk-feed-config.ts` — expanded UK RSS feed list
- `src/news/rns-scraper.ts` — RNS news scraper with circuit breaker
- `src/evals/research-agent/fixtures/lse-corpus.json` — hand-labelled LSE eval corpus
- `scripts/seed-ftse100.ts` — one-off seeder that adds FTSE-100 to paper strategy universes
- `scripts/export-lse-eval-corpus.ts` — one-off eval corpus exporter
- `tests/data/ftse100.test.ts`
- `tests/news/alias-overrides.test.ts`
- `tests/news/rss-feeds.test.ts` (may already exist — extend if so)
- `tests/news/rns-scraper.test.ts`
- `tests/news/research-agent.test.ts` (may already exist — extend if so)
- `tests/data/fmp-active-trading.test.ts`

**Modified files:**
- `src/db/schema.ts` — add `universe_cache` table
- `src/evolution/prompt.ts` — import and inject `NEWS_PIPELINE_CONTEXT`
- `src/strategy/dispatch-prompt.ts` — import and inject `NEWS_PIPELINE_CONTEXT`
- `src/news/rss-feeds.ts` — dynamic alias loader, financial-context filter, collision blacklist, import from uk-feed-config
- `src/news/research-agent.ts` — `buildUniverseWhitelist`, prompt whitelist block, primary-symbol pin, post-parse filter
- `src/data/fmp.ts` — `isActivelyTrading` check in `fmpValidateSymbol`
- `src/evals/research-agent/tasks.ts` — 20 new tasks
- `src/evals/research-agent/graders.ts` — 3 new code graders + Sonnet judge
- `src/evals/research-agent/suite.ts` — wire whitelist input through the suite
- `.env.example` — document `RESEARCH_WHITELIST_ENFORCE`, `RNS_SCRAPER_ENABLED`

---

## Phase 0 — Agent context docs

### Task 1: Create subsystem context module

**Files:**
- Create: `src/agents/subsystem-context.ts`
- Test: none (pure constants)

- [ ] **Step 1: Create the file with the shared context constants**

```ts
// src/agents/subsystem-context.ts
//
// Subsystem context blocks injected into runtime LLM prompts (evolution,
// dispatch, etc.) so agents understand invariants that are not obvious from
// the current code snapshot. See docs/specs/2026-04-10-lse-news-signal-fix.md
// for rationale.

export const NEWS_PIPELINE_CONTEXT = `
## News pipeline (current architecture)

- UK symbols matched via RSS + RNS text match using FTSE-100 aliases.
- The primary symbol from the RSS matcher is authoritative attribution.
- The research agent (Sonnet) filters its output against the paper-strategy
  whitelist. Symbols outside the whitelist are dropped before reaching
  news_analyses.
- To surface a new symbol to the news loop, add it to a strategy's universe.
  Do NOT hand-patch the research agent prompt to add symbols.
- FTSE-100 aliases are derived dynamically from FMP + src/news/alias-overrides.ts.
  Add nicknames (e.g. "HSBC" for HSBA) to the overrides file, not to rss-feeds.ts.
`.trim();
```

- [ ] **Step 2: Type-check and lint**

Run: `bunx tsc --noEmit && bunx biome check src/agents/subsystem-context.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/agents/subsystem-context.ts
git commit -m "feat(agents): add shared subsystem-context module for runtime prompt injection"
```

---

### Task 2: Inject news pipeline context into evolution prompt

**Files:**
- Modify: `src/evolution/prompt.ts`
- Test: `tests/evolution/prompt.test.ts` (or extend existing)

- [ ] **Step 1: Find the evolution prompt builder**

Read: `src/evolution/prompt.ts` — locate `buildEvolutionPrompt` and the `SYSTEM_PROMPT` constant.

- [ ] **Step 2: Write a failing test asserting the context block appears in the prompt**

Create or extend `tests/evolution/prompt.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { buildEvolutionPrompt } from "../../src/evolution/prompt.ts";
import { NEWS_PIPELINE_CONTEXT } from "../../src/agents/subsystem-context.ts";
import type { PerformanceLandscape } from "../../src/evolution/types.ts";

describe("buildEvolutionPrompt news context", () => {
	it("includes the news pipeline subsystem context", () => {
		const landscape: PerformanceLandscape = {
			strategies: [],
			activePaperCount: 0,
			recentMutations: [],
			insights: [],
		};
		const { system } = buildEvolutionPrompt(landscape);
		expect(system).toContain("News pipeline (current architecture)");
		expect(system).toContain(NEWS_PIPELINE_CONTEXT);
	});
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/evolution/prompt.test.ts`
Expected: FAIL (context string not present)

- [ ] **Step 4: Import and inject the context into the system prompt**

In `src/evolution/prompt.ts`, add this import at the top:

```ts
import { NEWS_PIPELINE_CONTEXT } from "../agents/subsystem-context.ts";
```

Then modify `SYSTEM_PROMPT` — append the context block at the end:

```ts
const SYSTEM_PROMPT = `You are a strategy evolution engine for an autonomous trading system.

Your job is to analyse a portfolio of paper-trading strategies and propose mutations that may improve performance.

## Mutation types
... (existing content unchanged) ...

For parameter_tweak, signals and universe may be omitted. For new_variant, both are required.

${NEWS_PIPELINE_CONTEXT}`;
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/evolution/prompt.test.ts`
Expected: PASS

- [ ] **Step 6: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```
All three must pass.

- [ ] **Step 7: Commit**

```bash
git add src/evolution/prompt.ts tests/evolution/prompt.test.ts
git commit -m "feat(evolution): inject news pipeline subsystem context into prompt"
```

---

### Task 3: Inject news pipeline context into dispatch prompt

**Files:**
- Modify: `src/strategy/dispatch-prompt.ts`
- Test: `tests/strategy/dispatch-prompt.test.ts` (create if missing)

- [ ] **Step 1: Write a failing test**

Create `tests/strategy/dispatch-prompt.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { buildDispatchPrompt } from "../../src/strategy/dispatch-prompt.ts";
import { NEWS_PIPELINE_CONTEXT } from "../../src/agents/subsystem-context.ts";

describe("buildDispatchPrompt news context", () => {
	it("includes the news pipeline subsystem context", () => {
		const prompt = buildDispatchPrompt(
			[],
			{ atr_percentile: 50, volume_breadth: 0.5, momentum_regime: 0.5 },
			[],
		);
		expect(prompt).toContain("News pipeline (current architecture)");
		expect(prompt).toContain(NEWS_PIPELINE_CONTEXT);
	});
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/strategy/dispatch-prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: Import and inject**

At the top of `src/strategy/dispatch-prompt.ts`:

```ts
import { NEWS_PIPELINE_CONTEXT } from "../agents/subsystem-context.ts";
```

Append the context to the returned template string. Find the line near the bottom of `buildDispatchPrompt` that closes the template literal (typically the "## Your task" or similar tail section), and add the context just before the closing backtick:

```ts
	return `... existing prompt body ...

${NEWS_PIPELINE_CONTEXT}`;
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/strategy/dispatch-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/strategy/dispatch-prompt.ts tests/strategy/dispatch-prompt.test.ts
git commit -m "feat(dispatch): inject news pipeline subsystem context into prompt"
```

---

### Task 4: Write nested CLAUDE.md files for self-improvement agent

**Files:**
- Create: `src/news/CLAUDE.md`
- Create: `src/evals/research-agent/CLAUDE.md`

- [ ] **Step 1: Write `src/news/CLAUDE.md`**

```markdown
# News Pipeline Subsystem

This directory implements the news→trade pipeline. Read this before touching any file in it.

**Canonical spec:** `docs/specs/2026-04-10-lse-news-signal-fix.md`
**Related problem statement:** `docs/plans/2026-04-10-lse-news-signal-gap.md`

## Pipeline map

```
UK RSS (10 feeds) + RNS scraper
  → rss-feeds.ts matchArticles()       # FTSE-100 aliases, financial-context filter, collision blacklist
  → news-poll-job.ts                    # routes US → Finnhub, non-US → RSS path
  → pre-filter.ts                       # 8 keyword blocks
  → classifier.ts (Haiku)               # single-symbol sentiment
  → research-agent.ts (Sonnet)          # whitelist-filtered, primary symbol pinned
  → fmp.ts fmpValidateSymbol()          # FMP /profile + isActivelyTrading check
  → news_analyses row (always logged)
  → sentiment-writer.ts → quotes_cache  # only if validatedTicker=1 AND inUniverse=1
```

## Invariants (do NOT break these)

1. **RSS matcher is authoritative for UK symbols.** The primary symbol from
   `matchArticles()` is pinned through the research agent. If the research
   agent drops it from its output, it is re-inserted with a neutralised signal
   (`direction="avoid"`, `confidence=0.5`) — the attribution is preserved.
2. **Research agent output is whitelist-filtered.** Any symbol not in a paper
   strategy universe is dropped before reaching `news_analyses` with a logged
   warning. Do not remove this filter.
3. **Alias management is dynamic.** FTSE-100 aliases are derived from FMP +
   `alias-overrides.ts`. Do not hand-edit `rss-feeds.ts` to add aliases —
   add them to `alias-overrides.ts` (reviewable in PRs).
4. **Collision blacklist tuning needs evals.** Before adding or removing a
   phrase from `COLLISION_BLACKLIST`, add or update an eval task in
   `src/evals/research-agent/` that demonstrates the fix.
5. **Classifier changes are out of scope.** The classifier is called per
   symbol and is not the source of attribution bugs. If classification
   quality is the problem, propose a spec — do not silently retune the
   classifier prompt.

## Surfacing a new symbol to the news loop

Add it to a strategy's universe. Do NOT add it directly to the research
agent prompt or the RSS alias map as a workaround. The universe is the
single source of truth for what gets traded.

## Related tests

- `tests/news/rss-feeds.test.ts`
- `tests/news/research-agent.test.ts`
- `tests/news/rns-scraper.test.ts`
- `src/evals/research-agent/` — regression-gating eval suite
```

- [ ] **Step 2: Write `src/evals/research-agent/CLAUDE.md`**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add src/news/CLAUDE.md src/evals/research-agent/CLAUDE.md
git commit -m "docs(news): add CLAUDE.md subsystem guides for self-improvement agent"
```

---

## Phase 1 — FTSE-100 universe seeding

### Task 5: Add `universe_cache` table via Drizzle migration

**Files:**
- Modify: `src/db/schema.ts`
- Generated: `drizzle/migrations/0009_*.sql`

- [ ] **Step 1: Add the table to `src/db/schema.ts`**

Append near the end of the schema file (after the last table definition):

```ts
// ── Universe cache ──────────────────────────────────────────────────────────

export const universeCache = sqliteTable("universe_cache", {
	key: text("key").primaryKey(),
	data: text("data").notNull(), // JSON blob
	fetchedAt: integer("fetched_at").notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new file `drizzle/migrations/0009_*.sql` appears and contains `CREATE TABLE \`universe_cache\``.

- [ ] **Step 3: Apply the migration locally**

Run: `bun run db:migrate`
Expected: "Migrations applied" or equivalent.

- [ ] **Step 4: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/migrations/
git commit -m "feat(db): add universe_cache table for FTSE-100 constituent caching"
```

---

### Task 6: Create `ftse100-fallback.json`

**Files:**
- Create: `src/data/ftse100-fallback.json`

- [ ] **Step 1: Write the fallback file**

Hand-committed FTSE-100 safety-net list. Structure mirrors `Ftse100Constituent` from Task 7. Include the ~100 current FTSE-100 symbols with their canonical company names. A representative excerpt:

```json
{
  "constituents": [
    { "symbol": "SHEL", "exchange": "LSE", "companyName": "Shell plc", "aliases": ["Shell", "Royal Dutch Shell"] },
    { "symbol": "BP.",  "exchange": "LSE", "companyName": "BP plc", "aliases": ["BP", "British Petroleum"] },
    { "symbol": "HSBA", "exchange": "LSE", "companyName": "HSBC Holdings plc", "aliases": ["HSBC", "HSBC Holdings"] },
    { "symbol": "AZN",  "exchange": "LSE", "companyName": "AstraZeneca plc", "aliases": ["AstraZeneca"] },
    { "symbol": "ULVR", "exchange": "LSE", "companyName": "Unilever plc", "aliases": ["Unilever"] },
    { "symbol": "VOD",  "exchange": "LSE", "companyName": "Vodafone Group plc", "aliases": ["Vodafone"] },
    { "symbol": "RIO",  "exchange": "LSE", "companyName": "Rio Tinto plc", "aliases": ["Rio Tinto"] },
    { "symbol": "GSK",  "exchange": "LSE", "companyName": "GSK plc", "aliases": ["GSK", "GlaxoSmithKline"] },
    { "symbol": "DGE",  "exchange": "LSE", "companyName": "Diageo plc", "aliases": ["Diageo"] },
    { "symbol": "LLOY", "exchange": "LSE", "companyName": "Lloyds Banking Group plc", "aliases": ["Lloyds", "Lloyds Banking Group"] }
    // ... populate all ~100 FTSE-100 members
  ],
  "fetchedAt": 0,
  "note": "Hand-maintained fallback. Source of truth is FMP; this file is only used if FMP fails."
}
```

Use the Wikipedia "FTSE 100 Index" article or a current broker list as the reference while writing this file. Make sure each entry has: symbol (LSE ticker, without .L suffix), exchange: "LSE", a canonical companyName, and 1-3 aliases derived from the companyName minus "plc"/"Holdings"/"Group".

- [ ] **Step 2: Sanity check — verify the JSON parses**

Run: `bun -e "console.log(require('./src/data/ftse100-fallback.json').constituents.length)"`
Expected: ~100

- [ ] **Step 3: Commit**

```bash
git add src/data/ftse100-fallback.json
git commit -m "feat(data): add hand-maintained FTSE-100 fallback universe"
```

---

### Task 7: Create `src/data/ftse100.ts` loader

**Files:**
- Create: `src/data/ftse100.ts`
- Test: `tests/data/ftse100.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/data/ftse100.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { getFtse100Universe, _resetFtse100Cache } from "../../src/data/ftse100.ts";

describe("getFtse100Universe", () => {
	beforeEach(() => {
		_resetFtse100Cache();
	});

	it("returns at least 90 FTSE-100 constituents from the fallback file", async () => {
		// Force fallback path by passing skipFmp=true
		const constituents = await getFtse100Universe({ skipFmp: true });
		expect(constituents.length).toBeGreaterThanOrEqual(90);
	});

	it("each constituent has symbol, exchange=LSE, companyName, aliases", async () => {
		const constituents = await getFtse100Universe({ skipFmp: true });
		for (const c of constituents) {
			expect(typeof c.symbol).toBe("string");
			expect(c.symbol.length).toBeGreaterThan(0);
			expect(c.exchange).toBe("LSE");
			expect(typeof c.companyName).toBe("string");
			expect(Array.isArray(c.aliases)).toBe(true);
			expect(c.aliases.length).toBeGreaterThan(0);
		}
	});

	it("normalises FMP .L suffix to bare symbol", async () => {
		const constituents = await getFtse100Universe({ skipFmp: true });
		for (const c of constituents) {
			expect(c.symbol.endsWith(".L")).toBe(false);
		}
	});
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/data/ftse100.test.ts`
Expected: FAIL ("module not found")

- [ ] **Step 3: Implement `src/data/ftse100.ts`**

```ts
// src/data/ftse100.ts

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { universeCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { fmpFetchRaw } from "./fmp.ts";
import fallback from "./ftse100-fallback.json" with { type: "json" };

const log = createChildLogger({ module: "ftse100" });

const CACHE_KEY = "ftse100";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Ftse100Constituent {
	symbol: string;
	exchange: "LSE";
	companyName: string;
	aliases: string[];
}

interface FallbackShape {
	constituents: Ftse100Constituent[];
}

let inMemoryCache: { data: Ftse100Constituent[]; fetchedAt: number } | null = null;

export function _resetFtse100Cache(): void {
	inMemoryCache = null;
}

export async function getFtse100Universe(
	options: { skipFmp?: boolean } = {},
): Promise<Ftse100Constituent[]> {
	// 1. In-memory cache (process lifetime)
	if (inMemoryCache && Date.now() - inMemoryCache.fetchedAt < CACHE_TTL_MS) {
		return inMemoryCache.data;
	}

	// 2. DB cache
	const db = getDb();
	const [row] = await db
		.select()
		.from(universeCache)
		.where(eq(universeCache.key, CACHE_KEY))
		.limit(1);

	if (row && Date.now() - row.fetchedAt < CACHE_TTL_MS) {
		try {
			const data = JSON.parse(row.data) as Ftse100Constituent[];
			inMemoryCache = { data, fetchedAt: row.fetchedAt };
			return data;
		} catch (err) {
			log.warn({ err }, "Failed to parse cached FTSE-100 data — refetching");
		}
	}

	// 3. FMP fetch
	if (!options.skipFmp) {
		try {
			const fresh = await fetchFromFmp();
			if (fresh.length >= 50) {
				await db
					.insert(universeCache)
					.values({ key: CACHE_KEY, data: JSON.stringify(fresh), fetchedAt: Date.now() })
					.onConflictDoUpdate({
						target: universeCache.key,
						set: { data: JSON.stringify(fresh), fetchedAt: Date.now() },
					});
				inMemoryCache = { data: fresh, fetchedAt: Date.now() };
				log.info({ count: fresh.length }, "FTSE-100 constituents refreshed from FMP");
				return fresh;
			}
			log.warn({ count: fresh.length }, "FMP returned sparse FTSE-100 data — falling back");
		} catch (err) {
			log.warn({ err }, "FMP FTSE-100 fetch failed — falling back");
		}
	}

	// 4. Fallback JSON
	const typed = fallback as unknown as FallbackShape;
	inMemoryCache = { data: typed.constituents, fetchedAt: Date.now() };
	return typed.constituents;
}

async function fetchFromFmp(): Promise<Ftse100Constituent[]> {
	// FMP endpoint for FTSE-100 constituents. The exact path may be
	// `/v3/symbol/FTSE` or `/v3/historical/ftse100_constituent` depending on
	// the plan tier. Try both; log and return [] if neither works.
	type FmpRow = { symbol: string; name: string; exchange?: string };
	let rows: FmpRow[] = [];

	try {
		rows = await fmpFetchRaw<FmpRow[]>("/symbol/FTSE", {});
	} catch {
		// try alternate path
		try {
			rows = await fmpFetchRaw<FmpRow[]>("/ftse100_constituent", {});
		} catch (err) {
			log.warn({ err }, "Both FMP FTSE-100 endpoints failed");
			return [];
		}
	}

	return rows.map((r) => {
		const bare = r.symbol.endsWith(".L") ? r.symbol.slice(0, -2) : r.symbol;
		return {
			symbol: bare,
			exchange: "LSE" as const,
			companyName: r.name,
			aliases: deriveAliases(r.name),
		};
	});
}

function deriveAliases(name: string): string[] {
	const cleaned = name
		.replace(/\s+plc\b/i, "")
		.replace(/\s+Holdings\b/i, "")
		.replace(/\s+Group\b/i, "")
		.trim();
	const aliases = new Set<string>();
	if (cleaned.length > 0) aliases.add(cleaned);
	aliases.add(name);
	return Array.from(aliases);
}
```

- [ ] **Step 4: Check for `fmpFetchRaw` availability in `src/data/fmp.ts`**

If `fmpFetchRaw` is not already exported from `src/data/fmp.ts`, it needs to be — it is the generic fetcher that `fmpFetch` wraps. Open `src/data/fmp.ts`, find the existing `fmpFetch` helper, and export a raw variant or export `fmpFetch` if that already matches the call shape. If only `fmpFetch<T>(path, params)` exists and accepts the same signature, use it instead:

Replace `fmpFetchRaw` calls with `fmpFetch` in Step 3 if the export names match.

- [ ] **Step 5: Run the test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/data/ftse100.test.ts`
Expected: PASS

- [ ] **Step 6: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/data/ftse100.ts tests/data/ftse100.test.ts
git commit -m "feat(data): FMP-backed FTSE-100 constituent loader with fallback"
```

---

### Task 8: Create `scripts/seed-ftse100.ts`

**Files:**
- Create: `scripts/seed-ftse100.ts`

- [ ] **Step 1: Write the seeder script**

```ts
// scripts/seed-ftse100.ts
//
// Adds FTSE-100 symbols to all paper strategies whose universe currently
// contains any LSE symbol. Dry-run by default. Pass --commit to apply.
//
// Usage:
//   bun scripts/seed-ftse100.ts            # dry run
//   bun scripts/seed-ftse100.ts --commit   # apply

import { eq } from "drizzle-orm";
import { getFtse100Universe } from "../src/data/ftse100.ts";
import { getDb } from "../src/db/client.ts";
import { strategies } from "../src/db/schema.ts";
import { createChildLogger } from "../src/utils/logger.ts";

const log = createChildLogger({ module: "seed-ftse100" });

async function main() {
	const commit = process.argv.includes("--commit");
	const ftse100 = await getFtse100Universe();
	log.info({ count: ftse100.length }, "FTSE-100 constituents loaded");

	const db = getDb();
	const paperStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	const ftse100Specs = ftse100.map((c) => `${c.symbol}:LSE`);
	let touched = 0;

	for (const s of paperStrategies) {
		const existing: string[] = JSON.parse(s.universe ?? "[]");
		const hasLse = existing.some((spec) => spec.endsWith(":LSE"));
		if (!hasLse) continue;

		const merged = Array.from(new Set([...existing, ...ftse100Specs]));
		if (merged.length === existing.length) continue;

		log.info(
			{
				strategyId: s.id,
				name: s.name,
				before: existing.length,
				after: merged.length,
				added: merged.length - existing.length,
			},
			commit ? "APPLYING" : "DRY RUN",
		);

		if (commit) {
			await db
				.update(strategies)
				.set({ universe: JSON.stringify(merged) })
				.where(eq(strategies.id, s.id));
		}
		touched++;
	}

	log.info({ touched, commit }, commit ? "Seed complete" : "Dry run complete");
}

main().catch((err) => {
	log.error({ err }, "Seeder failed");
	process.exit(1);
});
```

- [ ] **Step 2: Dry-run locally**

Run: `bun scripts/seed-ftse100.ts`
Expected: logs showing which strategies *would* be updated, no DB writes. No errors.

- [ ] **Step 3: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check scripts/
```

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-ftse100.ts
git commit -m "feat(scripts): FTSE-100 universe seeder for paper strategies"
```

- [ ] **Step 5: Note for production rollout**

After this PR merges, run the seeder on the VPS in dry-run first, then commit:
```
ssh <VPS> "cd /opt/trader-v2 && /home/deploy/.bun/bin/bun scripts/seed-ftse100.ts"
ssh <VPS> "cd /opt/trader-v2 && /home/deploy/.bun/bin/bun scripts/seed-ftse100.ts --commit"
```

Record this as a post-merge operational step in the PR description. Do NOT run it automatically from the task.

---

### Task 9: Phase-1 verification checkpoint

- [ ] **Step 1: Verify DB migration applied cleanly**

Run: `bun -e "import { getDb } from './src/db/client.ts'; import { universeCache } from './src/db/schema.ts'; await getDb().select().from(universeCache).limit(1); console.log('ok');"`
Expected: "ok"

- [ ] **Step 2: Verify loader returns >= 90 constituents (fallback path)**

Run: `bun -e "import { getFtse100Universe } from './src/data/ftse100.ts'; console.log((await getFtse100Universe({ skipFmp: true })).length);"`
Expected: ≥ 90

- [ ] **Step 3: No commit (checkpoint only)**

---

## Phase 2 — RSS/RNS source expansion

### Task 10: Extract feeds to `uk-feed-config.ts`

**Files:**
- Create: `src/news/uk-feed-config.ts`
- Modify: `src/news/rss-feeds.ts`

- [ ] **Step 1: Create `src/news/uk-feed-config.ts`**

```ts
// src/news/uk-feed-config.ts

export interface UkRssFeed {
	name: string;
	url: string;
}

export const UK_FEEDS: readonly UkRssFeed[] = [
	// Existing feeds
	{ name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
	{ name: "Yahoo Finance UK", url: "https://uk.finance.yahoo.com/rss/topstories" },
	{
		name: "Yahoo Finance FTSE",
		url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^FTSE&region=UK&lang=en-GB",
	},
	{ name: "Proactive Investors UK", url: "https://www.proactiveinvestors.co.uk/rss/all_news" },
	{ name: "Investing.com UK", url: "https://www.investing.com/rss/news_301.rss" },

	// New additions — any URL that 404s on first fetch is logged and skipped
	{ name: "Sharecast", url: "https://www.sharecast.com/rss/news" },
	{ name: "London South East", url: "https://www.lse.co.uk/rss/MarketNews" },
	{
		name: "Proactive Investors AIM",
		url: "https://www.proactiveinvestors.co.uk/rss/all_news/aim",
	},
	{ name: "Reuters UK Business", url: "https://feeds.reuters.com/reuters/UKBusinessNews" },
	{ name: "Citywire", url: "https://citywire.com/funds-insider/rss" },
];
```

- [ ] **Step 2: Update `src/news/rss-feeds.ts` to import from the config**

Replace the existing `UK_FEEDS` constant block in `src/news/rss-feeds.ts` with:

```ts
import { UK_FEEDS, type UkRssFeed } from "./uk-feed-config.ts";
```

Remove the local `RssFeed` interface (now `UkRssFeed` imported from config). Update `fetchUkFeeds` to use the imported `UK_FEEDS`.

- [ ] **Step 3: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/news/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/news/uk-feed-config.ts src/news/rss-feeds.ts
git commit -m "feat(news): extract UK RSS feeds to config and add 5 new sources"
```

---

### Task 11: Create `src/news/alias-overrides.ts` with test

**Files:**
- Create: `src/news/alias-overrides.ts`
- Create: `tests/news/alias-overrides.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/news/alias-overrides.test.ts
import { describe, expect, it } from "bun:test";
import { ALIAS_OVERRIDES } from "../../src/news/alias-overrides.ts";

describe("ALIAS_OVERRIDES", () => {
	it("is a non-empty map keyed by LSE symbol", () => {
		expect(Object.keys(ALIAS_OVERRIDES).length).toBeGreaterThan(0);
	});

	it("has known nickname aliases", () => {
		expect(ALIAS_OVERRIDES.HSBA).toContain("HSBC");
		expect(ALIAS_OVERRIDES.SHEL).toContain("Shell");
	});

	it("every override is a non-empty string array", () => {
		for (const [sym, aliases] of Object.entries(ALIAS_OVERRIDES)) {
			expect(Array.isArray(aliases)).toBe(true);
			expect(aliases.length).toBeGreaterThan(0);
			for (const a of aliases) {
				expect(typeof a).toBe("string");
				expect(a.length).toBeGreaterThan(0);
			}
		}
	});
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/news/alias-overrides.test.ts`
Expected: FAIL

- [ ] **Step 3: Create `src/news/alias-overrides.ts`**

```ts
// src/news/alias-overrides.ts
//
// Hand-maintained nickname aliases for FTSE-100 symbols. Merged with FMP-
// derived aliases in rss-feeds.ts at load time. Add new entries here rather
// than editing rss-feeds.ts directly.
//
// See src/news/CLAUDE.md for rationale.

export const ALIAS_OVERRIDES: Record<string, string[]> = {
	SHEL: ["Shell", "Royal Dutch Shell"],
	"BP.": ["BP", "British Petroleum"],
	HSBA: ["HSBC", "HSBC Holdings"],
	AZN: ["AstraZeneca"],
	GSK: ["GSK", "GlaxoSmithKline"],
	ULVR: ["Unilever"],
	VOD: ["Vodafone"],
	RIO: ["Rio Tinto"],
	LLOY: ["Lloyds", "Lloyds Banking Group"],
	BARC: ["Barclays"],
	NWG: ["NatWest", "NatWest Group"],
	STAN: ["Standard Chartered"],
	DGE: ["Diageo"],
	REL: ["RELX"],
	PRU: ["Prudential"],
	LGEN: ["Legal & General", "Legal and General"],
	AAL: ["Anglo American"],
	GLEN: ["Glencore"],
	CNA: ["Centrica"],
	SSE: ["SSE"],
	BT_A: ["BT Group", "BT"],
	IMB: ["Imperial Brands"],
	BATS: ["British American Tobacco", "BAT"],
	TSCO: ["Tesco"],
	SBRY: ["Sainsbury", "Sainsbury's"],
};
```

- [ ] **Step 4: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/news/alias-overrides.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/news/alias-overrides.ts tests/news/alias-overrides.test.ts
git commit -m "feat(news): add alias-overrides map for FTSE-100 nicknames"
```

---

### Task 12: Refactor `rss-feeds.ts` — dynamic alias loader

**Files:**
- Modify: `src/news/rss-feeds.ts`
- Create or extend: `tests/news/rss-feeds.test.ts`

- [ ] **Step 1: Write failing tests for the new behaviour**

```ts
// tests/news/rss-feeds.test.ts
import { describe, expect, it, beforeEach } from "bun:test";
import { _resetRssAliasCache, loadAliases } from "../../src/news/rss-feeds.ts";
import { _resetFtse100Cache } from "../../src/data/ftse100.ts";

describe("loadAliases (dynamic)", () => {
	beforeEach(() => {
		_resetRssAliasCache();
		_resetFtse100Cache();
	});

	it("returns aliases for FTSE-100 symbols from the fallback universe", async () => {
		const aliases = await loadAliases({ skipFmp: true });
		expect(aliases.SHEL).toBeDefined();
		expect(aliases.SHEL).toContain("Shell");
	});

	it("merges ALIAS_OVERRIDES with FMP-derived aliases", async () => {
		const aliases = await loadAliases({ skipFmp: true });
		expect(aliases.HSBA).toContain("HSBC");
	});

	it("caches within a 1-hour TTL", async () => {
		const first = await loadAliases({ skipFmp: true });
		const second = await loadAliases({ skipFmp: true });
		expect(first).toBe(second); // same reference = cached
	});
});
```

- [ ] **Step 2: Run — verify failure**

Run: `bun test --preload ./tests/preload.ts tests/news/rss-feeds.test.ts`
Expected: FAIL (`loadAliases` and `_resetRssAliasCache` not exported)

- [ ] **Step 3: Implement `loadAliases` in `src/news/rss-feeds.ts`**

Add these imports at the top of `src/news/rss-feeds.ts`:

```ts
import { getFtse100Universe } from "../data/ftse100.ts";
import { ALIAS_OVERRIDES } from "./alias-overrides.ts";
```

Replace the existing hardcoded `SYMBOL_ALIASES` constant with the dynamic loader:

```ts
const ALIAS_TTL_MS = 60 * 60 * 1000;
let aliasCache: { data: Record<string, string[]>; fetchedAt: number } | null = null;

export function _resetRssAliasCache(): void {
	aliasCache = null;
}

export async function loadAliases(
	options: { skipFmp?: boolean } = {},
): Promise<Record<string, string[]>> {
	if (aliasCache && Date.now() - aliasCache.fetchedAt < ALIAS_TTL_MS) {
		return aliasCache.data;
	}

	const constituents = await getFtse100Universe({ skipFmp: options.skipFmp });
	const aliases: Record<string, string[]> = {};
	for (const c of constituents) {
		aliases[c.symbol] = [...c.aliases];
	}
	for (const [sym, extra] of Object.entries(ALIAS_OVERRIDES)) {
		aliases[sym] = Array.from(new Set([...(aliases[sym] ?? []), ...extra]));
	}
	aliasCache = { data: aliases, fetchedAt: Date.now() };
	return aliases;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/news/rss-feeds.test.ts`
Expected: PASS

- [ ] **Step 5: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/news/rss-feeds.ts tests/news/rss-feeds.test.ts
git commit -m "feat(news): dynamic alias loader backed by FTSE-100 universe + overrides"
```

---

### Task 13: Add financial-context filter and collision blacklist

**Files:**
- Modify: `src/news/rss-feeds.ts`
- Extend: `tests/news/rss-feeds.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/news/rss-feeds.test.ts`:

```ts
import { _test_hasFinancialContext, _test_hasCollision } from "../../src/news/rss-feeds.ts";

describe("hasFinancialContext", () => {
	it("accepts headlines with plc, shares, earnings, etc.", () => {
		expect(_test_hasFinancialContext("Shell plc reports record profit")).toBe(true);
		expect(_test_hasFinancialContext("BP shares jump on earnings")).toBe(true);
		expect(_test_hasFinancialContext("Vodafone trading update disappoints")).toBe(true);
	});

	it("rejects headlines without financial context", () => {
		expect(_test_hasFinancialContext("Shell seashells on the seashore")).toBe(false);
		expect(_test_hasFinancialContext("BP oil spill ruled unlawful")).toBe(false);
	});
});

describe("hasCollision", () => {
	it("flags known collision phrases per symbol", () => {
		expect(_test_hasCollision("SHEL", "Using shell script for deploy")).toBe(true);
		expect(_test_hasCollision("SHEL", "Shell plc dividend raised")).toBe(false);
	});

	it("returns false for symbols without a blacklist entry", () => {
		expect(_test_hasCollision("AZN", "Anything at all here")).toBe(false);
	});
});
```

- [ ] **Step 2: Run — verify failure**

Run: `bun test --preload ./tests/preload.ts tests/news/rss-feeds.test.ts`
Expected: FAIL (test helpers not exported)

- [ ] **Step 3: Implement the helpers and wire them into `matchArticles`**

Add to `src/news/rss-feeds.ts`:

```ts
const FINANCIAL_CONTEXT_TERMS = [
	"plc",
	"ltd",
	"holdings",
	"ftse",
	"shares",
	"stock",
	"dividend",
	"earnings",
	"ceo",
	"results",
	"trading update",
	"profit",
	"revenue",
	"guidance",
	"pre-tax",
	"interim",
	"half-year",
	"full-year",
	"agm",
	"rights issue",
	"placing",
];

function hasFinancialContext(text: string): boolean {
	const lower = text.toLowerCase();
	return FINANCIAL_CONTEXT_TERMS.some((t) => lower.includes(t));
}

const COLLISION_BLACKLIST: Record<string, string[]> = {
	SHEL: ["shell script", "shell company", "shell game", "in a shell", "seashell"],
	"BP.": ["blood pressure", "bp oil spill"],
};

function hasCollision(symbol: string, text: string): boolean {
	const phrases = COLLISION_BLACKLIST[symbol];
	if (!phrases) return false;
	const lower = text.toLowerCase();
	return phrases.some((p) => lower.includes(p));
}

// Test-only exports (prefixed with _test_ to indicate non-public)
export const _test_hasFinancialContext = hasFinancialContext;
export const _test_hasCollision = hasCollision;
```

Now update `matchArticles` to (1) use dynamic aliases, (2) require financial context, (3) reject collisions:

```ts
function matchArticles(
	items: RssItem[],
	symbol: string,
	aliases: string[],
): NewsArticle[] {
	const searchTerms: string[] = [symbol.replace(".", "")];
	if (symbol.includes(".")) searchTerms.push(symbol);
	searchTerms.push(...aliases);

	const matched: NewsArticle[] = [];
	for (const item of items) {
		const text = `${item.title} ${item.snippet}`;
		if (!searchTerms.some((term) => text.toUpperCase().includes(term.toUpperCase()))) continue;
		if (!hasFinancialContext(text)) continue;
		if (hasCollision(symbol, text)) continue;

		matched.push({
			headline: item.title,
			symbols: [symbol],
			url: item.link || null,
			source: item.source,
			publishedAt: item.pubDate,
			finnhubId: null,
		});
	}
	return matched;
}
```

Update the caller `fetchUkNewsForSymbols` to load aliases once and pass them per symbol:

```ts
export async function fetchUkNewsForSymbols(
	symbols: Array<{ symbol: string; exchange: string }>,
): Promise<Map<string, NewsArticle[]>> {
	const ukSymbols = symbols.filter((s) => s.exchange !== "NASDAQ" && s.exchange !== "NYSE");
	if (ukSymbols.length === 0) return new Map();

	const aliases = await loadAliases();
	const items = await fetchUkFeeds();
	log.info(
		{ feedItems: items.length, symbols: ukSymbols.length },
		"RSS feeds fetched for UK symbols",
	);

	const result = new Map<string, NewsArticle[]>();
	for (const { symbol } of ukSymbols) {
		const symAliases = aliases[symbol] ?? [];
		const articles = matchArticles(items, symbol, symAliases);
		if (articles.length > 0) result.set(symbol, articles);
	}
	return result;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/news/rss-feeds.test.ts`
Expected: PASS

- [ ] **Step 5: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/news/rss-feeds.ts tests/news/rss-feeds.test.ts
git commit -m "feat(news): financial-context filter and collision blacklist in RSS matcher"
```

---

### Task 14: Create RNS scraper with circuit breaker

**Files:**
- Create: `src/news/rns-scraper.ts`
- Create: `tests/news/rns-scraper.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/news/rns-scraper.test.ts
import { describe, expect, it, beforeEach } from "bun:test";
import {
	fetchRnsNews,
	_resetRnsCircuitBreaker,
	_getRnsCircuitState,
} from "../../src/news/rns-scraper.ts";

describe("RNS scraper", () => {
	beforeEach(() => {
		_resetRnsCircuitBreaker();
	});

	it("respects the RNS_SCRAPER_ENABLED flag", async () => {
		process.env.RNS_SCRAPER_ENABLED = "false";
		const items = await fetchRnsNews(["SHEL"]);
		expect(items).toEqual([]);
		delete process.env.RNS_SCRAPER_ENABLED;
	});

	it("opens the circuit after 3 consecutive failures", async () => {
		// Use a fetch mock that returns 403
		const origFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response("forbidden", { status: 403 });
		try {
			await fetchRnsNews(["SHEL", "BP.", "HSBA"]);
			expect(_getRnsCircuitState()).toBe("open");
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});
```

- [ ] **Step 2: Run — verify failure**

Run: `bun test --preload ./tests/preload.ts tests/news/rns-scraper.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/news/rns-scraper.ts`**

```ts
// src/news/rns-scraper.ts
//
// Polite scraper for the LSE RNS (Regulatory News Service) news listings.
// Runs from the UK news poll path when RNS_SCRAPER_ENABLED is not "false".
// Opens a circuit breaker after 3 consecutive failures to avoid banging on
// a blocking endpoint.
//
// See docs/specs/2026-04-10-lse-news-signal-fix.md Section 3.4 for rationale.

import type { NewsArticle } from "./finnhub.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "rns-scraper" });

const USER_AGENT = "TraderV2-Research/1.0 (+https://github.com/)";
const RATE_LIMIT_MS = 1000;
const FAILURE_THRESHOLD = 3;

type CircuitState = "closed" | "open";
let circuitState: CircuitState = "closed";
let consecutiveFailures = 0;

export function _resetRnsCircuitBreaker(): void {
	circuitState = "closed";
	consecutiveFailures = 0;
}

export function _getRnsCircuitState(): CircuitState {
	return circuitState;
}

function isEnabled(): boolean {
	return process.env.RNS_SCRAPER_ENABLED !== "false";
}

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

function rnsUrlFor(symbol: string): string {
	// LSE site uses bare ticker. Returns the stock news listing page.
	return `https://www.londonstockexchange.com/stock/${encodeURIComponent(symbol)}/news`;
}

function recordFailure(): void {
	consecutiveFailures++;
	if (consecutiveFailures >= FAILURE_THRESHOLD && circuitState === "closed") {
		circuitState = "open";
		log.warn(
			{ failures: consecutiveFailures },
			"RNS scraper circuit breaker OPEN — disabled for this poll cycle",
		);
	}
}

function recordSuccess(): void {
	consecutiveFailures = 0;
}

async function scrapeOne(symbol: string): Promise<NewsArticle[]> {
	const url = rnsUrlFor(symbol);
	try {
		const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
		if (!resp.ok) {
			log.warn({ symbol, status: resp.status }, "RNS fetch returned non-ok status");
			recordFailure();
			return [];
		}
		const html = await resp.text();
		recordSuccess();
		return parseRnsHtml(symbol, html);
	} catch (err) {
		log.warn({ symbol, err }, "RNS fetch threw");
		recordFailure();
		return [];
	}
}

function parseRnsHtml(symbol: string, html: string): NewsArticle[] {
	// Minimal parse. The LSE page lists news items in structured markup.
	// Pull headline + timestamp + link with a tolerant regex; if the HTML
	// layout changes, return [] rather than throwing.
	const articles: NewsArticle[] = [];
	const itemPattern =
		/<article[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<time[^>]*datetime="([^"]+)"/g;
	let match: RegExpExecArray | null;
	while ((match = itemPattern.exec(html)) !== null) {
		const link = match[1] ?? "";
		const rawTitle = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
		const pubIso = match[3] ?? "";
		if (!rawTitle) continue;
		const publishedAt = new Date(pubIso);
		if (Number.isNaN(publishedAt.getTime())) continue;
		if (Date.now() - publishedAt.getTime() > 24 * 60 * 60 * 1000) continue;
		articles.push({
			headline: rawTitle,
			symbols: [symbol],
			url: link.startsWith("http") ? link : `https://www.londonstockexchange.com${link}`,
			source: "RNS",
			publishedAt,
			finnhubId: null,
		});
	}
	return articles;
}

export async function fetchRnsNews(symbols: string[]): Promise<NewsArticle[]> {
	if (!isEnabled()) {
		log.debug("RNS scraper disabled via env flag");
		return [];
	}

	const all: NewsArticle[] = [];
	for (const sym of symbols) {
		if (circuitState === "open") break;
		const batch = await scrapeOne(sym);
		all.push(...batch);
		await sleep(RATE_LIMIT_MS);
	}
	log.info({ symbols: symbols.length, articles: all.length, circuit: circuitState }, "RNS scrape complete");
	return all;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/news/rns-scraper.test.ts`
Expected: PASS

- [ ] **Step 5: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/news/rns-scraper.ts tests/news/rns-scraper.test.ts
git commit -m "feat(news): RNS scraper with rate limiter and circuit breaker"
```

---

### Task 15: Wire RNS scraper into the news poll path

**Files:**
- Modify: `src/scheduler/news-poll-job.ts`

- [ ] **Step 1: Update the non-US branch to merge RNS results with RSS results**

In `src/scheduler/news-poll-job.ts`, import the new scraper:

```ts
import { fetchRnsNews } from "../news/rns-scraper.ts";
```

In the non-US branch (currently around lines 97–111), add an RNS fetch that runs in parallel and merges results. Replace the existing non-US block:

```ts
	// Non-US stocks (LSE, AIM): RSS feeds + RNS scraper
	const nonUsSymbols = watchlist.filter((s) => s.exchange !== "NASDAQ" && s.exchange !== "NYSE");
	if (nonUsSymbols.length > 0) {
		const [rssResults, rnsArticles] = await Promise.all([
			fetchUkNewsForSymbols(nonUsSymbols),
			fetchRnsNews(nonUsSymbols.map((s) => s.symbol)),
		]);

		// Index RNS articles by symbol for lookup
		const rnsBySymbol = new Map<string, NewsArticle[]>();
		for (const a of rnsArticles) {
			const sym = a.symbols[0];
			if (!sym) continue;
			const list = rnsBySymbol.get(sym) ?? [];
			list.push(a);
			rnsBySymbol.set(sym, list);
		}

		for (const { symbol, exchange } of nonUsSymbols) {
			const rss = rssResults.get(symbol) ?? [];
			const rns = rnsBySymbol.get(symbol) ?? [];
			for (const article of [...rss, ...rns]) {
				totalArticles++;
				const result = await processArticle(article, exchange, classifyHeadline);
				if (result === "classified") classified++;
				else if (result === "filtered") filtered++;
				else if (result === "duplicate") duplicates++;
			}
		}
	}
```

Add the `NewsArticle` type import at the top if not already present:

```ts
import type { NewsArticle } from "../news/finnhub.ts";
```

- [ ] **Step 2: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/scheduler/news-poll-job.ts
git commit -m "feat(news): merge RNS scraper into UK news poll path"
```

---

### Task 16: Document env flags in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add the two new env vars**

Open `.env.example` and add near the other feature flags:

```
# News pipeline feature flags
# Set RESEARCH_WHITELIST_ENFORCE=false to disable the whitelist filter in the
# research agent (kill switch — reverts to pre-2026-04-10 behaviour).
RESEARCH_WHITELIST_ENFORCE=true
# Set RNS_SCRAPER_ENABLED=false to skip the LSE RNS scraper entirely.
RNS_SCRAPER_ENABLED=true
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: document RESEARCH_WHITELIST_ENFORCE and RNS_SCRAPER_ENABLED env flags"
```

---

## Phase 3 — Research-agent refactor + evals

### Task 17: Build `buildUniverseWhitelist` helper

**Files:**
- Modify: `src/news/research-agent.ts`
- Create or extend: `tests/news/research-agent.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/news/research-agent.test.ts (create if missing; otherwise extend)
import { describe, expect, it, beforeEach } from "bun:test";
import { buildUniverseWhitelist } from "../../src/news/research-agent.ts";
import { getDb } from "../../src/db/client.ts";
import { strategies } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";

describe("buildUniverseWhitelist", () => {
	beforeEach(async () => {
		const db = getDb();
		await db.delete(strategies).where(eq(strategies.createdBy, "test"));
	});

	it("returns deduped {symbol, exchange} pairs from all paper strategies", async () => {
		const db = getDb();
		await db.insert(strategies).values([
			{
				name: "t1",
				description: "test",
				parameters: "{}",
				universe: JSON.stringify(["SHEL:LSE", "BP.:LSE", "AAPL"]),
				status: "paper",
				createdBy: "test",
			},
			{
				name: "t2",
				description: "test",
				parameters: "{}",
				universe: JSON.stringify(["SHEL:LSE", "MSFT"]),
				status: "paper",
				createdBy: "test",
			},
		]);

		const whitelist = await buildUniverseWhitelist();
		const keys = new Set(whitelist.map((w) => `${w.symbol}:${w.exchange}`));
		expect(keys.has("SHEL:LSE")).toBe(true);
		expect(keys.has("BP.:LSE")).toBe(true);
		expect(keys.has("AAPL:NASDAQ")).toBe(true);
		expect(keys.has("MSFT:NASDAQ")).toBe(true);
		// deduped
		expect(whitelist.filter((w) => w.symbol === "SHEL" && w.exchange === "LSE").length).toBe(1);
	});

	it("ignores non-paper strategies", async () => {
		const db = getDb();
		await db.insert(strategies).values({
			name: "t3",
			description: "test",
			parameters: "{}",
			universe: JSON.stringify(["EXCLUDED:LSE"]),
			status: "retired",
			createdBy: "test",
		});
		const whitelist = await buildUniverseWhitelist();
		expect(whitelist.find((w) => w.symbol === "EXCLUDED")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run — verify failure**

Run: `bun test --preload ./tests/preload.ts tests/news/research-agent.test.ts`
Expected: FAIL (`buildUniverseWhitelist` not exported)

- [ ] **Step 3: Add `buildUniverseWhitelist` to `src/news/research-agent.ts`**

At the top of the file, ensure these imports exist:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
```

Add the helper (export it):

```ts
export async function buildUniverseWhitelist(): Promise<
	Array<{ symbol: string; exchange: string }>
> {
	const db = getDb();
	const rows = await db
		.select({ universe: strategies.universe })
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	const seen = new Set<string>();
	const result: Array<{ symbol: string; exchange: string }> = [];
	for (const row of rows) {
		if (!row.universe) continue;
		let list: string[];
		try {
			list = JSON.parse(row.universe);
		} catch {
			continue;
		}
		for (const spec of list) {
			const [sym, ex] = spec.includes(":") ? spec.split(":") : [spec, "NASDAQ"];
			if (!sym || !ex) continue;
			const key = `${sym}:${ex}`;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push({ symbol: sym, exchange: ex });
		}
	}
	return result;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/news/research-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/news/research-agent.ts tests/news/research-agent.test.ts
git commit -m "feat(research-agent): add buildUniverseWhitelist helper"
```

---

### Task 18: Refactor `buildResearchPrompt` to accept whitelist

**Files:**
- Modify: `src/news/research-agent.ts`
- Extend: `tests/news/research-agent.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/news/research-agent.test.ts`:

```ts
import { buildResearchPrompt } from "../../src/news/research-agent.ts";

describe("buildResearchPrompt whitelist", () => {
	const input = {
		headline: "Shell plc raises dividend",
		source: "Sharecast",
		symbols: ["SHEL"],
		classification: {
			sentiment: 0.4,
			confidence: 0.8,
			tradeable: true,
			eventType: "dividend",
			urgency: "medium",
		},
	};
	const whitelist = [
		{ symbol: "SHEL", exchange: "LSE" },
		{ symbol: "BP.", exchange: "LSE" },
	];

	it("includes the whitelist in the prompt", () => {
		const prompt = buildResearchPrompt(input, { whitelist, primaryExchange: "LSE" });
		expect(prompt).toContain("Tradeable universe");
		expect(prompt).toContain("SHEL:LSE");
		expect(prompt).toContain("BP.:LSE");
	});

	it("includes the primary symbol pin instruction", () => {
		const prompt = buildResearchPrompt(input, { whitelist, primaryExchange: "LSE" });
		expect(prompt).toContain("Primary attribution");
		expect(prompt).toContain(`"SHEL:LSE"`);
	});
});
```

- [ ] **Step 2: Run — verify failure**

Run: `bun test --preload ./tests/preload.ts tests/news/research-agent.test.ts`
Expected: FAIL (signature doesn't accept a second argument)

- [ ] **Step 3: Update `buildResearchPrompt` signature and body**

Replace `buildResearchPrompt` in `src/news/research-agent.ts`:

```ts
export function buildResearchPrompt(
	input: ResearchInput,
	ctx: {
		whitelist: Array<{ symbol: string; exchange: string }>;
		primaryExchange: string;
	},
): string {
	const primarySymbol = input.symbols[0] ?? "unknown";
	const whitelistLine = ctx.whitelist.map((w) => `${w.symbol}:${w.exchange}`).join(", ");

	return `You are a financial research analyst. Analyse this news headline and identify ALL materially affected publicly-traded symbols — not just the one originally classified.

## Headline
"${input.headline}"

## Source
${input.source}

## Symbols mentioned
${input.symbols.join(", ")}

## Initial classification (for the primary symbol ${primarySymbol})
- Sentiment: ${input.classification.sentiment}
- Confidence: ${input.classification.confidence}
- Event type: ${input.classification.eventType}
- Urgency: ${input.classification.urgency}

## Tradeable universe
You may ONLY return symbols from this whitelist. Any symbol not in this list
will be dropped. Use the exchange listed.

<whitelist>
${whitelistLine}
</whitelist>

## Primary attribution
This headline was matched to "${primarySymbol}:${ctx.primaryExchange}" by the
upstream RSS matcher. Unless the headline is entirely unrelated to that company,
you MUST include "${primarySymbol}" in your output with your independent
sentiment assessment. If the headline IS unrelated, return an empty array.

## Your task
Identify every publicly-traded symbol materially affected by this news. For each, provide:
- symbol: ticker (e.g., AVGO, GOOGL)
- exchange: one of NASDAQ, NYSE, LSE
- sentiment: -1.0 to 1.0 (from this symbol's perspective)
- urgency: low, medium, or high
- event_type: what this event means for THIS symbol
- direction: long, short, or avoid
- trade_thesis: one sentence explaining the trade case
- confidence: 0 to 1

Include the originally-classified symbol with your independent assessment. Look for:
- Direct parties (buyer/seller, partners)
- Supply chain effects (suppliers, customers)
- Sector peers affected by competitive dynamics
- M&A targets or acquirers

Return only valid exchange tickers as traded on NASDAQ, NYSE, or LSE. Use the ticker symbol, not the company name (e.g. TSM not TSMC, MBLY not MOBILEYE, BRK-B not BRK.B). If unsure of the exact ticker, omit the symbol rather than guess.

Respond with JSON only, no markdown:
{"affected_symbols": [...]}`;
}
```

- [ ] **Step 4: Update the existing `runResearchAnalysis` call site**

In `runResearchAnalysis`, before building the prompt, compute the whitelist and pass it. Find the line `const prompt = buildResearchPrompt(input);` and replace it:

```ts
	const whitelist = await buildUniverseWhitelist();
	// Determine primary exchange — use the exchange of the first symbol in the
	// input. For UK RSS path this is "LSE"; for Finnhub path this is the caller
	// exchange. `runResearchAnalysis` receives the exchange implicitly through
	// `isSymbolInUniverse` lookups, but the prompt needs it explicitly.
	const primaryExchange = input.symbols[0]
		? (whitelist.find((w) => w.symbol === input.symbols[0])?.exchange ?? "NASDAQ")
		: "NASDAQ";
	const prompt = buildResearchPrompt(input, { whitelist, primaryExchange });
```

**Note on primary exchange:** this derivation is brittle if the symbol appears in multiple exchanges. For Phase 3 this is acceptable because (a) FTSE-100 symbols are LSE-only and (b) US symbols are NASDAQ/NYSE-unique in our universes. If a cross-listing case surfaces, add an `exchange` field to `ResearchInput` in a follow-up.

- [ ] **Step 5: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/news/research-agent.test.ts`
Expected: PASS

- [ ] **Step 6: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/news/research-agent.ts tests/news/research-agent.test.ts
git commit -m "feat(research-agent): whitelist-aware prompt with primary attribution pin"
```

---

### Task 19: Post-parse whitelist filter + primary-symbol pin

**Files:**
- Modify: `src/news/research-agent.ts`
- Extend: `tests/news/research-agent.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { _test_filterAndPin } from "../../src/news/research-agent.ts";
import type { ResearchAnalysis } from "../../src/news/research-agent.ts";

describe("filterAndPin", () => {
	const whitelist = [
		{ symbol: "SHEL", exchange: "LSE" },
		{ symbol: "BP.", exchange: "LSE" },
		{ symbol: "AAPL", exchange: "NASDAQ" },
	];

	it("drops symbols not in the whitelist", () => {
		const analyses: ResearchAnalysis[] = [
			{
				symbol: "SHEL",
				exchange: "LSE",
				sentiment: 0.5,
				urgency: "medium",
				eventType: "dividend",
				direction: "long",
				tradeThesis: "Dividend raised",
				confidence: 0.8,
				recommendTrade: true,
			},
			{
				symbol: "PANASONIC",
				exchange: "LSE",
				sentiment: 0.1,
				urgency: "low",
				eventType: "mention",
				direction: "long",
				tradeThesis: "Mentioned",
				confidence: 0.5,
				recommendTrade: false,
			},
		];
		const result = _test_filterAndPin(analyses, "SHEL", "LSE", whitelist);
		expect(result.map((a) => a.symbol)).toEqual(["SHEL"]);
	});

	it("re-inserts the primary symbol with neutralised signal if the LLM drops it", () => {
		const analyses: ResearchAnalysis[] = [
			{
				symbol: "BP.",
				exchange: "LSE",
				sentiment: 0.3,
				urgency: "medium",
				eventType: "dividend",
				direction: "long",
				tradeThesis: "Benefits from sector mood",
				confidence: 0.7,
				recommendTrade: true,
			},
		];
		const result = _test_filterAndPin(analyses, "SHEL", "LSE", whitelist);
		const shel = result.find((a) => a.symbol === "SHEL");
		expect(shel).toBeDefined();
		expect(shel?.direction).toBe("avoid");
		expect(shel?.confidence).toBe(0.5);
		expect(shel?.recommendTrade).toBe(false);
	});

	it("does not pin if the primary symbol is outside the whitelist", () => {
		const analyses: ResearchAnalysis[] = [];
		const result = _test_filterAndPin(analyses, "NOTINLIST", "LSE", whitelist);
		expect(result).toEqual([]);
	});

	it("respects RESEARCH_WHITELIST_ENFORCE=false kill switch", () => {
		process.env.RESEARCH_WHITELIST_ENFORCE = "false";
		try {
			const analyses: ResearchAnalysis[] = [
				{
					symbol: "PANASONIC",
					exchange: "LSE",
					sentiment: 0.1,
					urgency: "low",
					eventType: "mention",
					direction: "long",
					tradeThesis: "Mentioned",
					confidence: 0.5,
					recommendTrade: false,
				},
			];
			const result = _test_filterAndPin(analyses, "PANASONIC", "LSE", whitelist);
			expect(result.map((a) => a.symbol)).toEqual(["PANASONIC"]);
		} finally {
			delete process.env.RESEARCH_WHITELIST_ENFORCE;
		}
	});
});
```

- [ ] **Step 2: Run — verify failure**

Run: `bun test --preload ./tests/preload.ts tests/news/research-agent.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `filterAndPin` and wire it into `runResearchAnalysis`**

Add to `src/news/research-agent.ts`:

```ts
function isWhitelistEnforced(): boolean {
	return process.env.RESEARCH_WHITELIST_ENFORCE !== "false";
}

function filterAndPin(
	analyses: ResearchAnalysis[],
	primarySymbol: string,
	primaryExchange: string,
	whitelist: Array<{ symbol: string; exchange: string }>,
): ResearchAnalysis[] {
	if (!isWhitelistEnforced()) return analyses;

	const whitelistSet = new Set(whitelist.map((w) => `${w.symbol}:${w.exchange}`));

	const filtered: ResearchAnalysis[] = [];
	for (const a of analyses) {
		const key = `${a.symbol}:${a.exchange}`;
		if (whitelistSet.has(key)) {
			filtered.push(a);
		} else {
			log.warn(
				{ symbol: a.symbol, exchange: a.exchange },
				"Research-agent output dropped (not in whitelist)",
			);
		}
	}

	const primaryKey = `${primarySymbol}:${primaryExchange}`;
	if (!whitelistSet.has(primaryKey)) return filtered;

	const primaryPresent = filtered.some(
		(a) => a.symbol === primarySymbol && a.exchange === primaryExchange,
	);
	if (!primaryPresent) {
		log.warn(
			{ primary: primaryKey },
			"Research-agent dropped primary symbol — re-inserting with neutralised signal",
		);
		filtered.push({
			symbol: primarySymbol,
			exchange: primaryExchange,
			sentiment: 0,
			urgency: "low",
			eventType: "unclassified",
			direction: "avoid",
			tradeThesis: "Primary symbol re-attributed after LLM omission",
			confidence: 0.5,
			recommendTrade: false,
		});
	}
	return filtered;
}

export const _test_filterAndPin = filterAndPin;
```

In `runResearchAnalysis`, after `parseResearchResponse(text)`, invoke the filter before the for-loop that writes to `news_analyses`. Replace:

```ts
			const analyses = parseResearchResponse(text);
			if (analyses.length === 0) {
```

with:

```ts
			const rawAnalyses = parseResearchResponse(text);
			const analyses = filterAndPin(
				rawAnalyses,
				input.symbols[0] ?? "",
				primaryExchange,
				whitelist,
			);
			if (analyses.length === 0) {
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/news/research-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/news/research-agent.ts tests/news/research-agent.test.ts
git commit -m "feat(research-agent): post-parse whitelist filter with primary symbol pin"
```

---

### Task 20: Update research-agent eval suite to pass whitelist

**Files:**
- Modify: `src/evals/research-agent/suite.ts`
- Modify: `src/evals/research-agent/tasks.ts`

- [ ] **Step 1: Extend `ResearchReference` with whitelist + primary-exchange fields**

In `src/evals/research-agent/tasks.ts`, add fields to the interface:

```ts
export interface ResearchReference {
	minSymbols: number;
	expectedSymbols: string[];
	expectedDirections: Record<string, "long" | "short" | "avoid">;
	expectedSentimentRange: Record<string, [number, number]>;
	isMultiParty: boolean;
	// New fields (Phase 3 research-agent refactor)
	whitelist?: Array<{ symbol: string; exchange: string }>;
	primaryExchange?: string;
	/** Symbols that must appear in the output (LSE attribution preservation). */
	requiredSymbols?: string[];
	/** Symbols that must NOT appear (deprecated-ticker rejection). */
	forbiddenSymbols?: string[];
}
```

For each existing task, add a sensible `whitelist` (e.g. the union of `expectedSymbols` plus a few distractors) and `primaryExchange: "NASDAQ"` (or NYSE/LSE as appropriate). Example edit for `ra-001`:

```ts
		reference: {
			minSymbols: 2,
			expectedSymbols: ["AVGO", "GOOGL"],
			expectedDirections: { AVGO: "long", GOOGL: "long" },
			expectedSentimentRange: { AVGO: [0.5, 1.0], GOOGL: [0.1, 0.5] },
			isMultiParty: true,
			whitelist: [
				{ symbol: "AVGO", exchange: "NASDAQ" },
				{ symbol: "GOOGL", exchange: "NASDAQ" },
				{ symbol: "AAPL", exchange: "NASDAQ" },
				{ symbol: "MSFT", exchange: "NASDAQ" },
			],
			primaryExchange: "NASDAQ",
			requiredSymbols: ["AVGO", "GOOGL"],
		},
```

Apply similar updates to every existing US task in the file. For each task, derive a plausible `whitelist` of 4–8 symbols that contains the `expectedSymbols` plus 2–4 distractors. Use `primaryExchange: "NASDAQ"` or `"NYSE"` according to the primary ticker's home.

- [ ] **Step 2: Update `src/evals/research-agent/suite.ts` to pass whitelist + primary exchange**

Replace the existing `runResearchAgentEvals` body's task runner:

```ts
	const results = await runSuite(
		researchAgentTasks,
		async (input, reference) => {
			const whitelist = reference.whitelist ?? [];
			const primaryExchange = reference.primaryExchange ?? "NASDAQ";
			const prompt = buildResearchPrompt(input, { whitelist, primaryExchange });
			const response = await client.messages.create({
				model: config.CLAUDE_MODEL,
				max_tokens: 1500,
				messages: [{ role: "user", content: prompt }],
			});
			const text = response.content[0]?.type === "text" ? response.content[0].text : "";
			return parseResearchResponse(text);
		},
		allResearchGraders,
		{ trials, suiteName: "research-agent" },
	);
```

Check that the `runSuite` harness passes `reference` as a second argument to the runner. If not, update the harness signature in `src/evals/harness.ts` to do so. (If the existing signature only passes `input`, extend it — the reference data is required for whitelist-aware runs.)

- [ ] **Step 3: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/evals/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/evals/research-agent/
git commit -m "feat(evals): wire whitelist + primary exchange through research-agent suite"
```

---

### Task 21: Add new code graders (A, B, C, E)

**Files:**
- Modify: `src/evals/research-agent/graders.ts`

- [ ] **Step 1: Append three new graders**

At the end of `src/evals/research-agent/graders.ts`, add:

```ts
/**
 * Category A grader: the primary RSS-matched symbol must be present.
 * Requires `reference.requiredSymbols` with at least one entry (the primary).
 */
export const primaryPresentGrader: RG = {
	name: "primary-present",
	type: "code",
	grade: async (output, reference) => {
		const required = reference.requiredSymbols ?? [];
		if (required.length === 0) {
			return { score: 1, pass: true, reason: "no required symbols configured" };
		}
		const have = new Set(output.map((a) => a.symbol));
		const missing = required.filter((s) => !have.has(s));
		return {
			score: missing.length === 0 ? 1 : 0,
			pass: missing.length === 0,
			reason: missing.length === 0
				? `All required symbols present (${required.join(", ")})`
				: `Missing required: ${missing.join(", ")}`,
		};
	},
};

/**
 * Category B grader: every output symbol must be in the whitelist.
 */
export const whitelistComplianceGrader: RG = {
	name: "whitelist-compliance",
	type: "code",
	grade: async (output, reference) => {
		const whitelist = reference.whitelist ?? [];
		if (whitelist.length === 0) {
			return { score: 1, pass: true, reason: "no whitelist configured" };
		}
		const allowed = new Set(whitelist.map((w) => `${w.symbol}:${w.exchange}`));
		const violations = output
			.map((a) => `${a.symbol}:${a.exchange}`)
			.filter((key) => !allowed.has(key));
		return {
			score: violations.length === 0 ? 1 : 0,
			pass: violations.length === 0,
			reason: violations.length === 0
				? "All outputs in whitelist"
				: `Outside whitelist: ${violations.join(", ")}`,
		};
	},
};

/**
 * Category E grader: no forbidden (e.g. deprecated) symbols may appear,
 * and all required (current replacement) symbols must.
 */
export const negativeRejectionGrader: RG = {
	name: "negative-rejection",
	type: "code",
	grade: async (output, reference) => {
		const forbidden = reference.forbiddenSymbols ?? [];
		const required = reference.requiredSymbols ?? [];
		const have = new Set(output.map((a) => a.symbol));
		const leaked = forbidden.filter((s) => have.has(s));
		const missing = required.filter((s) => !have.has(s));
		const pass = leaked.length === 0 && missing.length === 0;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass
				? "No forbidden symbols, all required present"
				: `Leaked: [${leaked.join(", ")}]; Missing: [${missing.join(", ")}]`,
		};
	},
};
```

Then add them to the `allResearchGraders` array (or equivalent export):

```ts
export const allResearchGraders: RG[] = [
	jsonShapeGrader,
	minSymbolsGrader,
	// ... existing graders ...
	primaryPresentGrader,
	whitelistComplianceGrader,
	negativeRejectionGrader,
];
```

- [ ] **Step 2: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/evals/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/evals/research-agent/graders.ts
git commit -m "feat(evals): add primary-present, whitelist-compliance, negative-rejection graders"
```

---

### Task 22: Add Sonnet-based thesis plausibility judge (Category D)

**Files:**
- Modify: `src/evals/research-agent/graders.ts`

- [ ] **Step 1: Append the Sonnet judge grader**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config.ts";

export const thesisPlausibilityJudge: RG = {
	name: "thesis-plausibility",
	type: "llm",
	grade: async (output, reference, context) => {
		// Only run when there is something to judge
		if (output.length === 0) {
			return { score: 0, pass: false, reason: "no analyses to judge" };
		}
		// Skip unless this task is a multi-party case (Category D)
		if (!reference.isMultiParty) {
			return { score: 1, pass: true, reason: "skipped (not multi-party)" };
		}

		const config = getConfig();
		const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
		const headline = context?.input?.headline ?? "unknown headline";
		const rubric = output
			.map((a) => `- ${a.symbol} (${a.direction}): ${a.tradeThesis}`)
			.join("\n");

		const prompt = `You are a financial analyst grading an AI-generated research output.

Headline: "${headline}"

The AI produced these trade theses:
${rubric}

For each symbol, judge whether the thesis is PLAUSIBLE given the headline.
Be strict: a thesis is plausible only if the connection between the headline
and the symbol's trade case is evident.

Respond with JSON only:
{ "judgments": [ { "symbol": "XYZ", "plausible": true|false, "reason": "..." } ] }`;

		try {
			const resp = await client.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 600,
				messages: [{ role: "user", content: prompt }],
			});
			const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
			const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
			const parsed = JSON.parse(cleaned) as {
				judgments: Array<{ symbol: string; plausible: boolean; reason: string }>;
			};
			const total = parsed.judgments.length;
			const passed = parsed.judgments.filter((j) => j.plausible).length;
			const pass = passed === total && total > 0;
			return {
				score: total > 0 ? passed / total : 0,
				pass,
				reason: `${passed}/${total} theses plausible`,
			};
		} catch (err) {
			return { score: 0, pass: false, reason: `judge failed: ${String(err)}` };
		}
	},
};
```

Add it to `allResearchGraders`:

```ts
export const allResearchGraders: RG[] = [
	// ... existing + new code graders ...
	thesisPlausibilityJudge,
];
```

**Note on harness signature:** the judge needs the headline from the input. If `Grader.grade()` does not currently receive a `context` argument with `input`, extend the harness type in `src/evals/types.ts` to pass it. A minimal extension:

```ts
// In src/evals/types.ts
export interface GraderContext<TInput> {
	input: TInput;
}

export interface Grader<TOutput, TReference, TInput = unknown> {
	name: string;
	type: "code" | "llm";
	grade(
		output: TOutput,
		reference: TReference,
		context?: GraderContext<TInput>,
	): Promise<GraderResult>;
}
```

Update the harness to pass `{ input: task.input }` when calling graders.

- [ ] **Step 2: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/evals/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/evals/research-agent/graders.ts src/evals/types.ts src/evals/harness.ts
git commit -m "feat(evals): Sonnet thesis-plausibility judge for multi-party tasks"
```

---

### Task 23: Bootstrap the LSE eval corpus

**Files:**
- Create: `scripts/export-lse-eval-corpus.ts`
- Create: `src/evals/research-agent/fixtures/lse-corpus.json`

- [ ] **Step 1: Write the exporter script**

```ts
// scripts/export-lse-eval-corpus.ts
//
// One-off exporter that pulls production LSE news events and their analyses
// into a JSON fixture used by the research-agent eval suite.
//
// Usage (run locally against a copy of the production DB):
//   bun scripts/export-lse-eval-corpus.ts > src/evals/research-agent/fixtures/lse-corpus.json

import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../src/db/client.ts";
import { newsAnalyses, newsEvents } from "../src/db/schema.ts";

async function main() {
	const db = getDb();
	const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

	const analyses = await db
		.select()
		.from(newsAnalyses)
		.where(and(eq(newsAnalyses.exchange, "LSE"), gte(newsAnalyses.createdAt, since)))
		.limit(200);

	const eventIds = Array.from(new Set(analyses.map((a) => a.newsEventId)));
	const events = eventIds.length
		? await db.select().from(newsEvents).where(inArray(newsEvents.id, eventIds))
		: [];

	const eventById = new Map(events.map((e) => [e.id, e]));

	const corpus = analyses
		.map((a) => {
			const evt = eventById.get(a.newsEventId);
			if (!evt) return null;
			return {
				headline: evt.headline,
				source: evt.source,
				primarySymbol: a.symbol,
				primaryExchange: a.exchange,
				initialSentiment: a.sentiment,
				// HAND-LABEL REQUIRED: set to the correct primary symbol after review
				correctPrimarySymbol: "",
				notes: "",
			};
		})
		.filter((r) => r !== null);

	console.log(JSON.stringify({ corpus }, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: Write placeholder fixture file with 5 hand-crafted Category A entries**

Since running the exporter requires access to the production DB and can happen as an operational step, bootstrap the fixture with 5 representative hand-crafted entries that the Category A tasks (Task 24) will consume:

```json
{
  "corpus": [
    {
      "headline": "Shell plc raises quarterly dividend by 4% as Q3 profit beats consensus",
      "source": "Sharecast",
      "primarySymbol": "SHEL",
      "primaryExchange": "LSE",
      "correctPrimarySymbol": "SHEL",
      "notes": "Clean single-symbol dividend announcement"
    },
    {
      "headline": "BP shares slide as trading update points to weaker refining margins",
      "source": "London South East",
      "primarySymbol": "BP.",
      "primaryExchange": "LSE",
      "correctPrimarySymbol": "BP.",
      "notes": "Negative trading update"
    },
    {
      "headline": "HSBC Holdings reports pre-tax profit of $7.7bn, beats forecast",
      "source": "Reuters UK Business",
      "primarySymbol": "HSBA",
      "primaryExchange": "LSE",
      "correctPrimarySymbol": "HSBA",
      "notes": "Earnings beat"
    },
    {
      "headline": "AstraZeneca plc receives EU approval for new oncology drug",
      "source": "Proactive Investors UK",
      "primarySymbol": "AZN",
      "primaryExchange": "LSE",
      "correctPrimarySymbol": "AZN",
      "notes": "Regulatory approval"
    },
    {
      "headline": "Vodafone Group plc announces sale of Italian unit for €8bn",
      "source": "BBC Business",
      "primarySymbol": "VOD",
      "primaryExchange": "LSE",
      "correctPrimarySymbol": "VOD",
      "notes": "Divestiture"
    }
  ]
}
```

Place at `src/evals/research-agent/fixtures/lse-corpus.json`.

- [ ] **Step 3: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check scripts/
```

- [ ] **Step 4: Commit**

```bash
git add scripts/export-lse-eval-corpus.ts src/evals/research-agent/fixtures/lse-corpus.json
git commit -m "feat(evals): bootstrap LSE corpus + exporter script"
```

---

### Task 24: Add 20 new eval tasks (Categories A–E)

**Files:**
- Modify: `src/evals/research-agent/tasks.ts`

- [ ] **Step 1: Add Category A tasks (5 — LSE attribution preservation)**

Append to the `researchAgentTasks` array in `src/evals/research-agent/tasks.ts`. Each task pulls its headline from `fixtures/lse-corpus.json`:

```ts
import corpus from "./fixtures/lse-corpus.json" with { type: "json" };

// Category A — LSE attribution preservation
const LSE_WHITELIST: Array<{ symbol: string; exchange: string }> = [
	{ symbol: "SHEL", exchange: "LSE" },
	{ symbol: "BP.", exchange: "LSE" },
	{ symbol: "HSBA", exchange: "LSE" },
	{ symbol: "AZN", exchange: "LSE" },
	{ symbol: "VOD", exchange: "LSE" },
	{ symbol: "GSK", exchange: "LSE" },
	{ symbol: "ULVR", exchange: "LSE" },
	{ symbol: "RIO", exchange: "LSE" },
	{ symbol: "DGE", exchange: "LSE" },
	{ symbol: "LLOY", exchange: "LSE" },
];

for (let i = 0; i < corpus.corpus.length && i < 5; i++) {
	const entry = corpus.corpus[i]!;
	researchAgentTasks.push({
		id: `ra-lse-a-${String(i + 1).padStart(3, "0")}`,
		name: `LSE attribution: ${entry.correctPrimarySymbol}`,
		input: {
			headline: entry.headline,
			source: entry.source,
			symbols: [entry.primarySymbol],
			classification: {
				sentiment: entry.initialSentiment ?? 0,
				confidence: 0.75,
				tradeable: true,
				eventType: "generic",
				urgency: "medium",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: [entry.correctPrimarySymbol],
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: false,
			whitelist: LSE_WHITELIST,
			primaryExchange: "LSE",
			requiredSymbols: [entry.correctPrimarySymbol],
		},
		tags: ["lse", "attribution", "category-a"],
	});
}
```

- [ ] **Step 2: Add Category B tasks (5 — LSE whitelist compliance)**

Append 5 synthetic distractor headlines:

```ts
const categoryBTasks = [
	{
		id: "ra-lse-b-001",
		name: "Distractor: Panasonic + Shell partnership",
		headline: "Panasonic and Shell announce battery supply deal for EV charging network",
		primary: "SHEL",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
	{
		id: "ra-lse-b-002",
		name: "Distractor: Samsung + HSBC mention",
		headline: "HSBC Holdings extends credit facility to Samsung Electronics",
		primary: "HSBA",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
	{
		id: "ra-lse-b-003",
		name: "Distractor: Tesla + BP charging",
		headline: "BP plc rolls out Tesla-compatible fast chargers across UK motorways",
		primary: "BP.",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
	{
		id: "ra-lse-b-004",
		name: "Distractor: Pfizer + AstraZeneca research",
		headline: "AstraZeneca plc and Pfizer publish joint oncology trial results",
		primary: "AZN",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
	{
		id: "ra-lse-b-005",
		name: "Distractor: Apple + Vodafone deal",
		headline: "Vodafone Group plc signs distribution deal with Apple Inc for iPhone 17",
		primary: "VOD",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
];

for (const t of categoryBTasks) {
	researchAgentTasks.push({
		id: t.id,
		name: t.name,
		input: {
			headline: t.headline,
			source: "synthetic",
			symbols: [t.primary],
			classification: {
				sentiment: 0.2,
				confidence: 0.7,
				tradeable: true,
				eventType: "partnership",
				urgency: "low",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: [t.primary],
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: false,
			whitelist: LSE_WHITELIST,
			primaryExchange: "LSE",
			requiredSymbols: [t.primary],
		},
		tags: t.tags,
	});
}
```

- [ ] **Step 3: Add Category C regression tasks (5 — US regression)**

The 5 existing US tasks (ra-001 to ra-005) already cover regression. Add tags and the new whitelist fields to each so they count as Category C. Add a tag pass:

```ts
// Category C — US regression (re-tagging existing tasks)
// Already exist as ra-001…ra-005. Verify their references include:
//   - whitelist with the expected symbols plus 2+ distractors
//   - primaryExchange set
//   - requiredSymbols = expectedSymbols
//   - tag "category-c" appended
```

If the existing tasks do not already have these fields (from Task 20), open the first 5 existing entries in `researchAgentTasks` and add `"category-c"` to their `tags` array, plus the `whitelist` / `primaryExchange` / `requiredSymbols` fields if they were not populated in Task 20.

- [ ] **Step 4: Add Category D tasks (3 — Multi-symbol LSE expansion)**

```ts
const categoryDTasks = [
	{
		id: "ra-lse-d-001",
		headline: "Shell and BP both raise dividends as oil majors ride higher crude prices",
		primary: "SHEL",
		expected: ["SHEL", "BP."],
	},
	{
		id: "ra-lse-d-002",
		headline: "Lloyds and NatWest shares rise on expectations of higher BoE base rate",
		primary: "LLOY",
		expected: ["LLOY", "NWG"],
	},
	{
		id: "ra-lse-d-003",
		headline: "AstraZeneca and GSK face combined pricing pressure from new NHS framework",
		primary: "AZN",
		expected: ["AZN", "GSK"],
	},
];

for (const t of categoryDTasks) {
	researchAgentTasks.push({
		id: t.id,
		name: `Multi-symbol LSE: ${t.expected.join("+")}`,
		input: {
			headline: t.headline,
			source: "synthetic",
			symbols: [t.primary],
			classification: {
				sentiment: 0.3,
				confidence: 0.75,
				tradeable: true,
				eventType: "sector",
				urgency: "medium",
			},
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: t.expected,
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: true,
			whitelist: LSE_WHITELIST.concat([{ symbol: "NWG", exchange: "LSE" }]),
			primaryExchange: "LSE",
			requiredSymbols: t.expected,
		},
		tags: ["lse", "multi-symbol", "category-d"],
	});
}
```

- [ ] **Step 5: Add Category E tasks (2 — Deprecated-ticker rejection)**

```ts
const categoryETasks = [
	{
		id: "ra-lse-e-001",
		headline: "Royal Dutch Shell reports record buyback programme for 2026",
		primary: "SHEL",
		forbidden: ["RDSB", "RDSA"],
		required: ["SHEL"],
		notes: "RDSB was the deprecated dual-listing ticker; current is SHEL",
	},
	{
		id: "ra-lse-e-002",
		headline: "Vodafone Group plc announces €8bn sale of Italian operations",
		primary: "VOD",
		forbidden: ["VOD.L"],
		required: ["VOD"],
		notes: "VOD.L is the FMP-suffixed form; our internal ticker is bare VOD",
	},
];

for (const t of categoryETasks) {
	researchAgentTasks.push({
		id: t.id,
		name: `Deprecated rejection: ${t.required.join("+")}`,
		input: {
			headline: t.headline,
			source: "synthetic",
			symbols: [t.primary],
			classification: {
				sentiment: 0.4,
				confidence: 0.8,
				tradeable: true,
				eventType: "corporate_action",
				urgency: "medium",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: t.required,
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: false,
			whitelist: LSE_WHITELIST,
			primaryExchange: "LSE",
			requiredSymbols: t.required,
			forbiddenSymbols: t.forbidden,
		},
		tags: ["lse", "deprecated", "category-e"],
	});
}
```

- [ ] **Step 6: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/evals/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 7: Run the eval suite once locally (single trial) to smoke-test shape**

Run: `bun src/evals/run.ts research-agent --trials 1`
Expected: completes, emits a results file, no crashes. Pass rate does not matter for this smoke check — just that the shape of tasks and graders works end-to-end.

- [ ] **Step 8: Commit**

```bash
git add src/evals/research-agent/tasks.ts
git commit -m "feat(evals): add 20 LSE/regression tasks (categories A-E)"
```

---

## Phase 4 — FMP `isActivelyTrading` guard

### Task 25: Extend `fmpValidateSymbol` to check `isActivelyTrading`

**Files:**
- Modify: `src/data/fmp.ts`
- Create: `tests/data/fmp-active-trading.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/data/fmp-active-trading.test.ts
import { describe, expect, it, afterEach } from "bun:test";
import { fmpValidateSymbol, _resetValidationCache } from "../../src/data/fmp.ts";

describe("fmpValidateSymbol isActivelyTrading", () => {
	const origFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = origFetch;
		_resetValidationCache();
	});

	it("rejects symbols with isActivelyTrading=false", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify([
					{ symbol: "RDSB.L", companyName: "Shell", exchange: "LSE", isActivelyTrading: false },
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		_resetValidationCache();
		const result = await fmpValidateSymbol("RDSB", "LSE");
		expect(result).toBe(false);
	});

	it("accepts symbols with isActivelyTrading=true", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify([
					{ symbol: "SHEL.L", companyName: "Shell", exchange: "LSE", isActivelyTrading: true },
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		_resetValidationCache();
		const result = await fmpValidateSymbol("SHEL", "LSE");
		expect(result).toBe(true);
	});

	it("accepts symbols without isActivelyTrading field (backwards compat)", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify([{ symbol: "SHEL.L", companyName: "Shell", exchange: "LSE" }]),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		_resetValidationCache();
		const result = await fmpValidateSymbol("SHEL", "LSE");
		expect(result).toBe(true);
	});
});
```

- [ ] **Step 2: Run — verify failure**

Run: `bun test --preload ./tests/preload.ts tests/data/fmp-active-trading.test.ts`
Expected: FAIL (the test for `RDSB` returns `true`, plus `_resetValidationCache` may not exist)

- [ ] **Step 3: Add `_resetValidationCache` if missing**

In `src/data/fmp.ts`, near `_resetRateLimiter`, add:

```ts
export function _resetValidationCache(): void {
	validationCache.clear();
}
```

- [ ] **Step 4: Add `isActivelyTrading` to the profile type and check**

In `src/data/fmp.ts`, update the `fmpValidateSymbol` body:

```ts
	try {
		const data = await fmpFetch<
			Array<{
				symbol: string;
				companyName: string;
				exchange: string;
				isActivelyTrading?: boolean;
			}>
		>(`/profile`, { symbol: fmpSym });

		let valid = !!data && data.length > 0;
		if (valid && data[0]?.isActivelyTrading === false) {
			log.info(
				{ symbol, exchange },
				"fmpValidateSymbol: rejecting symbol with isActivelyTrading=false",
			);
			valid = false;
		}
		validationCache.set(cacheKey, { valid, expiresAt: now + VALIDATION_TTL_MS });
		return valid;
	} catch {
		validationCache.set(cacheKey, { valid: false, expiresAt: now + VALIDATION_TTL_MS });
		return false;
	}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/data/fmp-active-trading.test.ts`
Expected: PASS

- [ ] **Step 6: Three-check gate**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/
bun test --preload ./tests/preload.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/data/fmp.ts tests/data/fmp-active-trading.test.ts
git commit -m "feat(fmp): reject symbols with isActivelyTrading=false"
```

---

### Task 26: Post-implementation verification checkpoint

- [ ] **Step 1: Run the full test suite**

Run: `bun test --preload ./tests/preload.ts`
Expected: all tests pass.

- [ ] **Step 2: Run type check and lint on the whole tree**

Run:
```
bunx tsc --noEmit
bunx biome check src/ tests/ scripts/
```
Expected: clean.

- [ ] **Step 3: Run the research-agent eval suite (single trial) for a final smoke test**

Run: `bun src/evals/run.ts research-agent --trials 1`
Expected: completes, results file written. Sanity-check Category A and B pass rates look plausible (≥60% on one trial); the production gate is 3-trial ≥90%, which runs in CI.

- [ ] **Step 4: Post-merge operational steps (record in PR description)**

After the PR merges and deploys to the VPS:

1. Run the seeder in dry-run first:
   ```
   ssh <VPS> "cd /opt/trader-v2 && /home/deploy/.bun/bin/bun scripts/seed-ftse100.ts"
   ```
   Review output.
2. Apply:
   ```
   ssh <VPS> "cd /opt/trader-v2 && /home/deploy/.bun/bin/bun scripts/seed-ftse100.ts --commit"
   ```
3. Watch the first 48 hours of logs for: `news_events` LSE row growth, RNS circuit-breaker status, whitelist-filter warnings.
4. At 7 days, query the success metrics from Section 1 of the spec:
   - `SELECT COUNT(*) FROM news_analyses WHERE exchange='LSE' AND created_at > datetime('now','-7 days');` ≥ 50
   - `SELECT SUM(in_universe)*1.0/COUNT(*) FROM news_analyses WHERE exchange='LSE' AND created_at > datetime('now','-7 days');` ≥ 0.6

---

## Self-Review Notes

This plan covers every requirement in `docs/specs/2026-04-10-lse-news-signal-fix.md`:

- **Spec §2** (architecture) → Tasks 12, 13, 14, 15, 17, 18, 19
- **Spec §3.1** (ftse100.ts) → Tasks 5, 6, 7
- **Spec §3.2** (alias-overrides) → Task 11
- **Spec §3.3** (rss-feeds modifications) → Tasks 12, 13
- **Spec §3.4** (rns-scraper) → Tasks 14, 15
- **Spec §3.5** (uk-feed-config) → Task 10
- **Spec §3.6** (research-agent refactor) → Tasks 17, 18, 19
- **Spec §3.7** (fmp isActivelyTrading) → Task 25
- **Spec §4** (eval strategy) → Tasks 20, 21, 22, 23, 24
- **Spec §5** (agent context) → Tasks 1, 2, 3, 4
- **Spec §6** (rollout phases) → Phase labels on every task
- **Spec §7** (universe_cache migration) → Task 5
- **Spec §8** (risks / kill switches) → Task 19 respects `RESEARCH_WHITELIST_ENFORCE`, Task 14 respects `RNS_SCRAPER_ENABLED`, Task 16 documents both
- **Spec §9** (feature flags) → Task 16

No `TODO`/`TBD` markers. Every code step includes the code. Every command has expected output.
