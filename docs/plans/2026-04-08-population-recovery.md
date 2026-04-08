# Population Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two-layer population recovery so the system self-heals when strategies are killed faster than created.

**Architecture:** VPS-side evolution cycle gets a population floor (`MIN_POPULATION = 3`) that bypasses the 30-trade gate in recovery mode, capped at 2 spawns biased toward structural mutations. GitHub Actions self-improvement agent gets a prompt paragraph making low population a critical diagnostic signal.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, Anthropic API, GitHub Actions

**Spec:** `docs/specs/2026-04-08-population-recovery.md`

---

### Task 1: Add `MIN_POPULATION` constant and `RECOVERY_SPAWN_CAP`

**Files:**
- Modify: `src/evolution/population.ts:8-9`

- [ ] **Step 1: Add the constants**

In `src/evolution/population.ts`, add two new exports after the existing constants:

```typescript
export const MAX_POPULATION = 8;
export const DRAWDOWN_KILL_PCT = 15;
export const MIN_POPULATION = 3;
export const RECOVERY_SPAWN_CAP = 2;
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `bun test --preload ./tests/preload.ts tests/evolution/population.test.ts`
Expected: All tests pass (constants are additive, no behaviour change)

- [ ] **Step 3: Commit**

```bash
git add src/evolution/population.ts
git commit -m "feat(evolution): add MIN_POPULATION and RECOVERY_SPAWN_CAP constants"
```

---

### Task 2: Add `createdBy` parameter to `spawnChild`

**Files:**
- Modify: `src/evolution/spawner.ts:6`
- Test: `tests/evolution/spawner.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe("spawnChild")` block in `tests/evolution/spawner.test.ts`:

```typescript
it("uses custom createdBy when provided", async () => {
	const { strategies } = await import("../../src/db/schema.ts");
	const { spawnChild } = await import("../../src/evolution/spawner.ts");

	const [parent] = await db
		.insert(strategies)
		.values({
			name: "parent-recovery",
			description: "Parent for recovery test",
			parameters: JSON.stringify({ stop_loss_pct: 3 }),
			signals: JSON.stringify({ entry_long: "rsi < 30" }),
			universe: JSON.stringify(["AAPL"]),
			status: "paper" as const,
			virtualBalance: 10000,
			generation: 1,
			createdBy: "seed",
		})
		.returning();

	const mutation: ValidatedMutation = {
		parentId: parent!.id,
		type: "structural",
		name: "recovery-strategy",
		description: "Recovery spawn",
		parameters: { stop_loss_pct: 4 },
		signals: { entry_long: "rsi < 25", exit: "rsi > 70" },
		universe: ["MSFT"],
		parameterDiff: {},
	};

	const childId = await spawnChild(mutation, "evolution:recovery");

	const { eq } = await import("drizzle-orm");
	const [child] = await db.select().from(strategies).where(eq(strategies.id, childId));

	expect(child!.createdBy).toBe("evolution:recovery");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/evolution/spawner.test.ts -t "uses custom createdBy"`
Expected: FAIL — `spawnChild` does not accept a second argument

- [ ] **Step 3: Implement the change**

In `src/evolution/spawner.ts`, change the function signature from:

```typescript
export async function spawnChild(mutation: ValidatedMutation): Promise<number> {
```

to:

```typescript
export async function spawnChild(mutation: ValidatedMutation, createdBy = "evolution"): Promise<number> {
```

And change the insert values from:

```typescript
		createdBy: "evolution",
```

to:

```typescript
		createdBy,
```

- [ ] **Step 4: Run all spawner tests to verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/evolution/spawner.test.ts`
Expected: All tests pass (existing tests use default `"evolution"`, new test uses override)

- [ ] **Step 5: Commit**

```bash
git add src/evolution/spawner.ts tests/evolution/spawner.test.ts
git commit -m "feat(evolution): add optional createdBy param to spawnChild"
```

---

### Task 3: Add recovery mode to evolution prompt

**Files:**
- Modify: `src/evolution/prompt.ts:71-126`
- Test: `tests/evolution/prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to the existing `describe("buildEvolutionPrompt")` block in `tests/evolution/prompt.test.ts`:

```typescript
test("includes POPULATION CRITICAL text when recoveryMode is true", () => {
	const landscape = makeLandscape({ activePaperCount: 2 });
	const { user } = buildEvolutionPrompt(landscape, true);
	expect(user).toContain("POPULATION CRITICAL");
	expect(user).toContain("structural");
});

test("does not include POPULATION CRITICAL text when recoveryMode is false", () => {
	const landscape = makeLandscape({ activePaperCount: 2 });
	const { user } = buildEvolutionPrompt(landscape, false);
	expect(user).not.toContain("POPULATION CRITICAL");
});

test("does not include POPULATION CRITICAL text by default", () => {
	const landscape = makeLandscape({ activePaperCount: 2 });
	const { user } = buildEvolutionPrompt(landscape);
	expect(user).not.toContain("POPULATION CRITICAL");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/evolution/prompt.test.ts -t "POPULATION CRITICAL"`
Expected: FAIL — `buildEvolutionPrompt` does not accept a second argument

- [ ] **Step 3: Implement the change**

In `src/evolution/prompt.ts`, change the function signature from:

```typescript
export function buildEvolutionPrompt(landscape: PerformanceLandscape): {
	system: string;
	user: string;
} {
```

to:

```typescript
export function buildEvolutionPrompt(landscape: PerformanceLandscape, recoveryMode = false): {
	system: string;
	user: string;
} {
```

Then, at the end of the `user` template string (before the closing backtick), add the recovery mode block. Replace the existing task section:

```typescript
	const recoveryBlock = recoveryMode
		? `\n\n**POPULATION CRITICAL:** Only ${activePaperCount}/${MAX_POPULATION} strategies active. Propose structural mutations — new signal logic, different entry/exit approaches, fresh universes. Prioritise diversity over data-driven tuning. Do NOT propose parameter_tweak — there is insufficient trade data.`
		: "";

	const user = `## Performance Landscape

Population: ${slotsUsed}

${strategyBlocks}

---

## Task

Propose mutations to improve this portfolio. Guidelines:
- Prioritise strategies with 30+ trades and Sharpe < 1.5 for parameter_tweak
- Propose a new_variant if ${slotsAvailable} slot(s) are available and there is a promising parent
- For \`parameter_tweak\` and \`new_variant\`, stay within parameter ranges. For \`structural\`, any parameter names are allowed, but max 5.
- Return only a JSON array — no additional text${recoveryBlock}`;
```

- [ ] **Step 4: Run all prompt tests to verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/evolution/prompt.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/evolution/prompt.ts tests/evolution/prompt.test.ts
git commit -m "feat(evolution): add recoveryMode flag to evolution prompt"
```

---

### Task 4: Add recovery mode bypass to evolution cycle

**Files:**
- Modify: `src/evolution/index.ts:11,88-105,138,166-168,192`
- Test: `tests/evolution/population-recovery.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/evolution/population-recovery.test.ts`:

```typescript
import { beforeEach, describe, expect, it, mock } from "bun:test";

// Mock Anthropic before importing the module under test
const mockCreate = mock(() =>
	Promise.resolve({
		content: [
			{
				type: "text" as const,
				text: JSON.stringify([
					{
						parentId: 1,
						type: "structural",
						name: "recovery-strat-1",
						description: "Recovery strategy 1",
						parameters: { stop_loss_pct: 5 },
						signals: { entry_long: "rsi14 < 25", exit: "hold_days > 5" },
						universe: ["AAPL", "MSFT"],
						reasoning: "Diversify into mean reversion",
					},
					{
						parentId: 1,
						type: "structural",
						name: "recovery-strat-2",
						description: "Recovery strategy 2",
						parameters: { stop_loss_pct: 3 },
						signals: { entry_long: "volume_ratio > 2", exit: "hold_days > 3" },
						universe: ["TSLA"],
						reasoning: "Volume breakout approach",
					},
					{
						parentId: 1,
						type: "structural",
						name: "recovery-strat-3",
						description: "Recovery strategy 3 — should be dropped due to cap",
						parameters: { stop_loss_pct: 4 },
						signals: { entry_long: "change_percent > 3", exit: "hold_days > 2" },
						universe: ["NVDA"],
						reasoning: "Momentum breakout",
					},
				]),
			},
		],
		usage: { input_tokens: 100, output_tokens: 200 },
	}),
);

mock.module("@anthropic-ai/sdk", () => ({
	default: class {
		messages = { create: mockCreate };
	},
}));

describe("evolution recovery mode", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { strategies, strategyMutations, strategyMetrics, tokenUsage, paperTrades, tradeInsights } =
			await import("../../src/db/schema.ts");
		await db.delete(tradeInsights);
		await db.delete(paperTrades);
		await db.delete(strategyMutations);
		await db.delete(strategyMetrics);
		await db.delete(tokenUsage);
		await db.delete(strategies);

		mockCreate.mockClear();
	});

	it("bypasses 30-trade gate when population is below MIN_POPULATION", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { runEvolutionCycle } = await import("../../src/evolution/index.ts");

		// Insert 2 strategies with 0 trades (below MIN_POPULATION of 3)
		await db.insert(strategies).values({
			name: "survivor-1",
			description: "A surviving strategy",
			parameters: JSON.stringify({ stop_loss_pct: 3 }),
			signals: JSON.stringify({ entry_long: "rsi14 < 30", exit: "rsi14 > 70" }),
			universe: JSON.stringify(["AAPL"]),
			status: "paper" as const,
			virtualBalance: 10000,
			generation: 1,
			createdBy: "seed",
		});
		await db.insert(strategies).values({
			name: "survivor-2",
			description: "Another surviving strategy",
			parameters: JSON.stringify({ stop_loss_pct: 4 }),
			signals: JSON.stringify({ entry_long: "rsi14 < 25", exit: "rsi14 > 75" }),
			universe: JSON.stringify(["MSFT"]),
			status: "paper" as const,
			virtualBalance: 10000,
			generation: 1,
			createdBy: "seed",
		});

		const result = await runEvolutionCycle();

		// Should NOT have skipped — should have called the API
		expect(result.skippedReason).toBeUndefined();
		expect(mockCreate).toHaveBeenCalledTimes(1);
	});

	it("caps recovery spawns at RECOVERY_SPAWN_CAP (2)", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { runEvolutionCycle } = await import("../../src/evolution/index.ts");

		await db.insert(strategies).values({
			name: "lone-survivor",
			description: "Only strategy left",
			parameters: JSON.stringify({ stop_loss_pct: 3 }),
			signals: JSON.stringify({ entry_long: "rsi14 < 30", exit: "rsi14 > 70" }),
			universe: JSON.stringify(["AAPL"]),
			status: "paper" as const,
			virtualBalance: 10000,
			generation: 1,
			createdBy: "seed",
		});

		const result = await runEvolutionCycle();

		// Mock returns 3 proposals but cap is 2
		expect(result.spawned.length).toBeLessThanOrEqual(2);
		expect(result.spawned.length).toBeGreaterThan(0);
	});

	it("tags recovery spawns with createdBy 'evolution:recovery'", async () => {
		const { strategies: strategiesTable } = await import("../../src/db/schema.ts");
		const { runEvolutionCycle } = await import("../../src/evolution/index.ts");
		const { eq } = await import("drizzle-orm");

		await db.insert(strategiesTable).values({
			name: "sole-survivor",
			description: "The only one left",
			parameters: JSON.stringify({ stop_loss_pct: 3 }),
			signals: JSON.stringify({ entry_long: "rsi14 < 30", exit: "rsi14 > 70" }),
			universe: JSON.stringify(["AAPL"]),
			status: "paper" as const,
			virtualBalance: 10000,
			generation: 1,
			createdBy: "seed",
		});

		const result = await runEvolutionCycle();

		for (const childId of result.spawned) {
			const [child] = await db
				.select()
				.from(strategiesTable)
				.where(eq(strategiesTable.id, childId));
			expect(child!.createdBy).toBe("evolution:recovery");
		}
	});

	it("still skips when population is at or above MIN_POPULATION with no 30-trade strategies", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { runEvolutionCycle } = await import("../../src/evolution/index.ts");

		// Insert 3 strategies (at MIN_POPULATION) with 0 trades
		for (let i = 0; i < 3; i++) {
			await db.insert(strategies).values({
				name: `strategy-${i}`,
				description: `Strategy ${i}`,
				parameters: JSON.stringify({ stop_loss_pct: 3 + i }),
				signals: JSON.stringify({ entry_long: "rsi14 < 30" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			});
		}

		const result = await runEvolutionCycle();

		// Should skip — population is not below MIN_POPULATION
		expect(result.skippedReason).toBe("no paper strategies with 30+ trades");
		expect(mockCreate).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/evolution/population-recovery.test.ts`
Expected: FAIL — recovery mode not implemented yet

- [ ] **Step 3: Implement recovery mode in the evolution cycle**

In `src/evolution/index.ts`, add the import:

```typescript
import { MAX_POPULATION, MIN_POPULATION, RECOVERY_SPAWN_CAP } from "./population";
```

(Replace the existing `import { MAX_POPULATION } from "./population";`)

Then replace the 30-trade check and the code that uses `slotsAvailable` (lines 91-168). The new logic:

```typescript
	// Step 5: Check if recovery mode is needed (population critically low)
	const recoveryMode = landscape.activePaperCount < MIN_POPULATION;

	if (!recoveryMode) {
		// Normal mode: skip if no paper strategies with 30+ trades
		const strategiesWithEnoughTrades = landscape.strategies.filter(
			(s) => s.status === "paper" && (s.metrics?.sampleSize ?? 0) >= 30,
		);

		if (strategiesWithEnoughTrades.length === 0) {
			log.info("Skipping evolution: no paper strategies with 30+ trades");
			return {
				drawdownKills,
				tournaments: tournamentResults.length,
				populationCulls,
				spawned: [],
				skippedReason: "no paper strategies with 30+ trades",
			};
		}
	} else {
		log.warn(
			{ activePaperCount: landscape.activePaperCount, min: MIN_POPULATION },
			"Population critically low — entering recovery mode",
		);
	}

	// Step 6: Skip if population is at cap
	if (landscape.activePaperCount >= MAX_POPULATION) {
		log.info(
			{ activePaperCount: landscape.activePaperCount, cap: MAX_POPULATION },
			"Skipping evolution: population at cap",
		);
		return {
			drawdownKills,
			tournaments: tournamentResults.length,
			populationCulls,
			spawned: [],
			skippedReason: "population at cap",
		};
	}

	// Step 7: Budget check
	const canAfford = await canAffordCall(EVOLUTION_ESTIMATED_COST_USD);
	if (!canAfford) {
		log.warn("Skipping evolution: insufficient budget for Sonnet call");
		return {
			drawdownKills,
			tournaments: tournamentResults.length,
			populationCulls,
			spawned: [],
			skippedReason: "insufficient budget",
		};
	}

	// Step 8 & 9: Call Sonnet with retry
	const config = getConfig();
	const client = new Anthropic();
	const { system, user } = buildEvolutionPrompt(landscape, recoveryMode);
```

And update the spawn cap logic (replace lines 165-168):

```typescript
	// Step 12 & 13: Validate and spawn, respecting population slots
	const maxSpawns = recoveryMode
		? Math.min(RECOVERY_SPAWN_CAP, MAX_POPULATION - landscape.activePaperCount)
		: MAX_POPULATION - landscape.activePaperCount;
	const spawned: number[] = [];
	let slotsUsed = 0;

	for (const proposal of proposals) {
		if (slotsUsed >= maxSpawns) {
			log.info({ proposalName: proposal.name }, "Skipping proposal: no population slots remaining");
			break;
		}
```

And update the `spawnChild` call to pass the createdBy tag:

```typescript
		try {
			const childId = await spawnChild(
				validation.mutation,
				recoveryMode ? "evolution:recovery" : "evolution",
			);
```

- [ ] **Step 4: Run the recovery tests to verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/evolution/population-recovery.test.ts`
Expected: All 4 tests pass

- [ ] **Step 5: Run the full evolution test suite**

Run: `bun test --preload ./tests/preload.ts tests/evolution/`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/evolution/index.ts tests/evolution/population-recovery.test.ts
git commit -m "feat(evolution): add population recovery mode with 30-trade bypass"
```

---

### Task 5: Add population health to self-improvement agent prompt

**Files:**
- Modify: `.github/workflows/claude.yml:65-71`

- [ ] **Step 1: Add population health focus area**

In `.github/workflows/claude.yml`, add a new bullet to the "Focus areas" list (after the existing "Cost efficiency" line):

```yaml
            - Population health — if activePaperCount is below 4, this is a CRITICAL priority.
              Investigate why strategies are being killed faster than created. Check graduation
              events for patterns (are kill thresholds too aggressive for current volatility?
              Are young strategies being culled before accumulating meaningful data?). Consider:
              adjusting DRAWDOWN_KILL_PCT, adding tournament protection for strategies with <10
              trades, writing new seed strategies with battle-tested parameters, or tuning the
              evolution floor's recovery spawn logic if you see repeated spawn-kill churn.
```

- [ ] **Step 2: Verify YAML is valid**

Run: `bun -e "const yaml = require('yaml'); const fs = require('fs'); yaml.parse(fs.readFileSync('.github/workflows/claude.yml', 'utf8')); console.log('YAML valid')"`
Expected: `YAML valid`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/claude.yml
git commit -m "feat(self-improvement): add population health awareness to agent prompt"
```

---

### Task 6: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript type check**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run Biome linter**

Run: `bunx biome check src/ tests/`
Expected: No errors (run with `--write` if formatting issues)

- [ ] **Step 3: Run the full test suite**

Run: `bun test --preload ./tests/preload.ts tests/`
Expected: All tests pass, including new recovery tests

- [ ] **Step 4: Final commit (if any lint fixes)**

```bash
git add -A
git commit -m "chore: lint fixes for population recovery"
```
