# Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the trader-v2 project with database schema, cherry-picked infrastructure, quote fetching, and a basic scheduler — producing a runnable system that fetches and caches live quotes.

**Architecture:** New Bun/TypeScript project in a separate directory (`~/Documents/Projects/trader-v2`). SQLite + Drizzle ORM for persistence. Cherry-pick utilities from the v1 codebase, adapt for the new schema. Yahoo Finance for quotes. Scheduler runs quote refresh on a timer.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, `bun:sqlite`, `yahoo-finance2` v3, `pino`, `node-cron`, `zod`, Biome v2 (tab indent, same config as v1)

**Spec:** `docs/specs/2026-04-03-trader-v2-design.md` (in the v1 repo)

---

## File Structure

```
trader-v2/
├── package.json
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── tests/
│   ├── preload.ts
│   ├── db/
│   │   └── schema.test.ts
│   ├── config.test.ts
│   ├── data/
│   │   └── quotes.test.ts
│   ├── utils/
│   │   ├── cost.test.ts
│   │   └── budget.test.ts
│   └── scheduler/
│       └── cron.test.ts
├── src/
│   ├── index.ts                  # Entry point — boot, connect, start scheduler
│   ├── config.ts                 # Env var parsing via Zod
│   ├── db/
│   │   ├── client.ts             # SQLite + Drizzle setup
│   │   ├── schema.ts             # All table definitions
│   │   └── migrate.ts            # Migration runner
│   ├── data/
│   │   └── quotes.ts             # Yahoo Finance quote fetching + cache
│   ├── utils/
│   │   ├── logger.ts             # Pino structured logging
│   │   ├── retry.ts              # Retry with backoff
│   │   ├── cost.ts               # API pricing calculations
│   │   ├── token-tracker.ts      # Usage recording
│   │   ├── budget.ts             # Daily spend tracking
│   │   └── fx.ts                 # GBP/USD conversion
│   ├── reporting/
│   │   └── email.ts              # Resend email integration
│   └── scheduler/
│       ├── cron.ts               # Cron job definitions
│       └── jobs.ts               # Job execution
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `trader-v2/package.json`
- Create: `trader-v2/tsconfig.json`
- Create: `trader-v2/biome.json`
- Create: `trader-v2/drizzle.config.ts`
- Create: `trader-v2/tests/preload.ts`
- Create: `trader-v2/.gitignore`

- [ ] **Step 1: Create the project directory and init git**

```bash
mkdir -p ~/Documents/Projects/trader-v2
cd ~/Documents/Projects/trader-v2
git init
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "trader-v2",
  "module": "src/index.ts",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "bun --hot src/index.ts | bunx pino-pretty",
    "start": "bun src/index.ts",
    "typecheck": "tsc --noEmit",
    "lint": "bunx biome check .",
    "lint:fix": "bunx biome check --fix .",
    "db:generate": "bunx drizzle-kit generate",
    "db:migrate": "bun src/db/migrate.ts",
    "test": "bun test --preload ./tests/preload.ts"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.3.15",
    "@types/bun": "latest",
    "drizzle-kit": "^0.31.9",
    "pino-pretty": "^13.1.3",
    "typescript": "^5.9.3"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.78.0",
    "drizzle-orm": "^0.45.1",
    "node-cron": "^4.2.1",
    "pino": "^10.3.1",
    "resend": "^6.9.2",
    "yahoo-finance2": "^3.13.0",
    "zod": "^4.3.6"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.15/schema.json",
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedImports": "warn",
        "noUnusedVariables": "warn"
      },
      "style": {
        "noNonNullAssertion": "off"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 100
  },
  "assist": {
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  },
  "files": {
    "includes": ["src/**", "tests/**"]
  }
}
```

- [ ] **Step 5: Create drizzle.config.ts**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/db/schema.ts",
	out: "./drizzle/migrations",
	dialect: "sqlite",
	dbCredentials: {
		url: process.env.DB_PATH ?? "./data/trader.db",
	},
});
```

- [ ] **Step 6: Create tests/preload.ts**

```typescript
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.RESEND_API_KEY = "test-key";
process.env.ALERT_EMAIL_TO = "test@example.com";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.DB_PATH = ":memory:";
```

- [ ] **Step 7: Create .gitignore**

```
node_modules/
data/
.env
*.db
*.db-wal
*.db-shm
dist/
```

- [ ] **Step 8: Install dependencies**

```bash
cd ~/Documents/Projects/trader-v2
bun install
```

Expected: lockfile created, no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold trader-v2 project"
```

---

### Task 2: Config

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";

// Reset module cache between tests so config re-parses
beforeEach(() => {
	// Config caches on first call — we test via env vars set in preload.ts
});

describe("getConfig", () => {
	test("parses required env vars from preload", async () => {
		const { getConfig } = await import("../src/config.ts");
		const config = getConfig();
		expect(config.ANTHROPIC_API_KEY).toBe("test-key");
		expect(config.NODE_ENV).toBe("test");
		expect(config.DB_PATH).toBe(":memory:");
	});

	test("applies defaults for optional vars", async () => {
		const { getConfig } = await import("../src/config.ts");
		const config = getConfig();
		expect(config.DAILY_API_BUDGET_USD).toBe(0);
		expect(config.LOG_LEVEL).toBe("error");
		expect(config.CLAUDE_MODEL_FAST).toContain("haiku");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Documents/Projects/trader-v2
bun test tests/config.test.ts
```

Expected: FAIL — cannot resolve `../src/config.ts`

- [ ] **Step 3: Write the implementation**

Create `src/config.ts`:

```typescript
import { z } from "zod";

const envSchema = z.object({
	// Claude
	ANTHROPIC_API_KEY: z.string(),
	CLAUDE_MODEL: z.string().default("claude-sonnet-4-5-20250929"),
	CLAUDE_MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),

	// Resend
	RESEND_API_KEY: z.string(),
	ALERT_EMAIL_FROM: z.string().default("trader@updates.example.com"),
	ALERT_EMAIL_TO: z.string(),

	// GitHub (for self-improvement PRs)
	GITHUB_TOKEN: z.string().optional(),
	GITHUB_REPO_OWNER: z.string().optional(),
	GITHUB_REPO_NAME: z.string().default("trader-v2"),

	// Database
	DB_PATH: z.string().default("./data/trader.db"),

	// Logging
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

	// Environment
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

	// Cost control
	DAILY_API_BUDGET_USD: z.coerce.number().default(0),

	// Finnhub
	FINNHUB_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function resetConfigForTesting(): void {
	_config = null;
}

export function getConfig(): Config {
	if (!_config) {
		const result = envSchema.safeParse(process.env);
		if (!result.success) {
			console.error("Invalid environment variables:");
			for (const issue of result.error.issues) {
				console.error(`  ${issue.path.join(".")}: ${issue.message}`);
			}
			process.exit(1);
		}
		_config = result.data;
	}
	return _config;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/config.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config module with Zod env parsing"
```

---

### Task 3: Logger + Retry Utilities

**Files:**
- Create: `src/utils/logger.ts`
- Create: `src/utils/retry.ts`

These are direct cherry-picks from v1 — no tests needed as they're proven code.

- [ ] **Step 1: Create src/utils/logger.ts**

```typescript
import pino from "pino";
import { getConfig } from "../config.ts";

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
	if (!_logger) {
		const config = getConfig();
		_logger = pino({
			level: config.LOG_LEVEL,
			base: { service: "trader-v2" },
			timestamp: pino.stdTimeFunctions.isoTime,
		});
	}
	return _logger;
}

export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
	return getLogger().child(bindings);
}
```

- [ ] **Step 2: Create src/utils/retry.ts**

```typescript
import { createChildLogger } from "./logger.ts";

const log = createChildLogger({ module: "retry" });

export interface RetryOptions {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	backoffMultiplier: number;
}

const defaultOptions: RetryOptions = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	backoffMultiplier: 2,
};

export async function withRetry<T>(
	fn: () => Promise<T>,
	label: string,
	options: Partial<RetryOptions> = {},
): Promise<T> {
	const opts = { ...defaultOptions, ...options };
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt === opts.maxAttempts) break;

			const delay = Math.min(
				opts.baseDelayMs * opts.backoffMultiplier ** (attempt - 1),
				opts.maxDelayMs,
			);
			log.warn(
				{ attempt, maxAttempts: opts.maxAttempts, delay, error: lastError.message },
				`${label}: retrying after error`,
			);
			await Bun.sleep(delay);
		}
	}

	throw lastError;
}
```

- [ ] **Step 3: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/utils/logger.ts src/utils/retry.ts
git commit -m "feat: add logger and retry utilities (cherry-pick from v1)"
```

---

### Task 4: Database Schema

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/client.ts`
- Create: `src/db/migrate.ts`
- Create: `tests/db/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/db/schema.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

describe("schema", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		// Create tables in :memory: DB
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("can insert and query a strategy", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		await db.insert(strategies).values({
			name: "test_strategy",
			description: "A test strategy",
			parameters: JSON.stringify({ rsi_threshold: 30 }),
			status: "paper",
			virtualBalance: 10000,
			generation: 1,
		});

		const rows = await db.select().from(strategies);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.name).toBe("test_strategy");
		expect(rows[0]!.status).toBe("paper");
		expect(rows[0]!.virtualBalance).toBe(10000);
	});

	test("can insert and query a paper trade", async () => {
		const { strategies, paperTrades } = await import("../../src/db/schema.ts");
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test",
				description: "test",
				parameters: "{}",
				status: "paper",
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(paperTrades).values({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			quantity: 5,
			price: 150.0,
			signalType: "entry_long",
			reasoning: "RSI oversold + positive news",
		});

		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(1);
		expect(trades[0]!.symbol).toBe("AAPL");
		expect(trades[0]!.side).toBe("BUY");
	});

	test("can insert and query quotes cache", async () => {
		const { quotesCache } = await import("../../src/db/schema.ts");
		await db.insert(quotesCache).values({
			symbol: "SHEL",
			exchange: "LSE",
			last: 2450.5,
			bid: 2449.0,
			ask: 2452.0,
			volume: 1200000,
			newsSentiment: 0.7,
		});

		const rows = await db
			.select()
			.from(quotesCache)
			.where(eq(quotesCache.symbol, "SHEL"));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.last).toBe(2450.5);
		expect(rows[0]!.newsSentiment).toBe(0.7);
	});

	test("can insert and query strategy metrics", async () => {
		const { strategies, strategyMetrics } = await import("../../src/db/schema.ts");
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test",
				description: "test",
				parameters: "{}",
				status: "paper",
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strat!.id,
			sampleSize: 35,
			winRate: 0.58,
			expectancy: 2.5,
			profitFactor: 1.45,
			sharpeRatio: 0.72,
			sortinoRatio: 1.1,
			maxDrawdownPct: 8.5,
			calmarRatio: 1.2,
			consistencyScore: 3,
		});

		const rows = await db.select().from(strategyMetrics);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.profitFactor).toBe(1.45);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/db/schema.test.ts
```

Expected: FAIL — cannot resolve schema/client modules

- [ ] **Step 3: Create src/db/client.ts**

```typescript
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getConfig } from "../config.ts";
import * as schema from "./schema.ts";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database | null = null;

export function getDb() {
	if (!_db) {
		const config = getConfig();
		const dbPath = config.DB_PATH;
		if (dbPath !== ":memory:") {
			const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
			if (dir) {
				const fs = require("node:fs");
				fs.mkdirSync(dir, { recursive: true });
			}
		}
		_sqlite = new Database(dbPath);
		_sqlite.exec("PRAGMA journal_mode = WAL;");
		_sqlite.exec("PRAGMA foreign_keys = ON;");
		_db = drizzle(_sqlite, { schema });
	}
	return _db;
}

export function closeDb() {
	if (_sqlite) {
		_sqlite.close();
		_sqlite = null;
		_db = null;
	}
}

export type DbClient = ReturnType<typeof getDb>;
```

- [ ] **Step 4: Create src/db/schema.ts**

```typescript
import { integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ── Strategies ──────────────────────────────────────────────────────────────

export const strategies = sqliteTable("strategies", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
	description: text("description").notNull(),
	parameters: text("parameters").notNull(), // JSON
	signals: text("signals"), // JSON: { entry_long, entry_short, exit }
	universe: text("universe"), // JSON: string[]
	status: text("status", {
		enum: ["paper", "probation", "active", "core", "retired"],
	})
		.notNull()
		.default("paper"),
	virtualBalance: real("virtual_balance").notNull().default(10000),
	parentStrategyId: integer("parent_strategy_id"),
	generation: integer("generation").notNull().default(1),
	createdBy: text("created_by").default("seed"), // "seed" | "evolution" | "human"
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	retiredAt: text("retired_at"),
});

// ── Paper Trading ───────────────────────────────────────────────────────────

export const paperPositions = sqliteTable("paper_positions", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id").notNull(),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull(),
	quantity: real("quantity").notNull(),
	entryPrice: real("entry_price").notNull(),
	currentPrice: real("current_price"),
	stopLoss: real("stop_loss"),
	trailingStop: real("trailing_stop"),
	highWaterMark: real("high_water_mark"),
	unrealizedPnl: real("unrealized_pnl"),
	openedAt: text("opened_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	closedAt: text("closed_at"),
});

export const paperTrades = sqliteTable("paper_trades", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id").notNull(),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull().default("NASDAQ"),
	side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
	quantity: real("quantity").notNull(),
	price: real("price").notNull(),
	friction: real("friction").notNull().default(0), // stamp duty + FX cost deducted
	pnl: real("pnl"),
	signalType: text("signal_type").notNull(), // entry_long, entry_short, exit
	reasoning: text("reasoning"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── Live Trading ────────────────────────────────────────────────────────────

export const livePositions = sqliteTable(
	"live_positions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		strategyId: integer("strategy_id"),
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		currency: text("currency").notNull().default("USD"),
		quantity: real("quantity").notNull(),
		avgCost: real("avg_cost").notNull(),
		currentPrice: real("current_price"),
		unrealizedPnl: real("unrealized_pnl"),
		marketValue: real("market_value"),
		stopLossPrice: real("stop_loss_price"),
		trailingStopPrice: real("trailing_stop_price"),
		highWaterMark: real("high_water_mark"),
		updatedAt: text("updated_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		symbolExchangeUnique: unique("live_positions_symbol_exchange_unique").on(
			table.symbol,
			table.exchange,
		),
	}),
);

export const liveTrades = sqliteTable("live_trades", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id"),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull(),
	side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
	quantity: real("quantity").notNull(),
	orderType: text("order_type", { enum: ["LIMIT", "MARKET"] }).notNull(),
	limitPrice: real("limit_price"),
	fillPrice: real("fill_price"),
	commission: real("commission"),
	friction: real("friction").notNull().default(0),
	status: text("status", {
		enum: ["PENDING", "SUBMITTED", "FILLED", "PARTIALLY_FILLED", "CANCELLED", "ERROR"],
	})
		.notNull()
		.default("PENDING"),
	ibOrderId: integer("ib_order_id"),
	reasoning: text("reasoning"),
	confidence: real("confidence"),
	pnl: real("pnl"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updated_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	filledAt: text("filled_at"),
});

// ── Market Data ─────────────────────────────────────────────────────────────

export const quotesCache = sqliteTable(
	"quotes_cache",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		last: real("last"),
		bid: real("bid"),
		ask: real("ask"),
		volume: integer("volume"),
		avgVolume: integer("avg_volume"),
		changePercent: real("change_percent"),
		newsSentiment: real("news_sentiment"), // written by news event bus
		updatedAt: text("updated_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		symbolExchangeUnique: unique("quotes_cache_symbol_exchange_unique").on(
			table.symbol,
			table.exchange,
		),
	}),
);

export const earningsCalendar = sqliteTable("earnings_calendar", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull(),
	date: text("date").notNull(),
	estimatedEps: real("estimated_eps"),
	source: text("source"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── Strategy Metrics & Graduation ───────────────────────────────────────────

export const strategyMetrics = sqliteTable("strategy_metrics", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id").notNull(),
	sampleSize: integer("sample_size").notNull().default(0),
	winRate: real("win_rate"),
	expectancy: real("expectancy"),
	profitFactor: real("profit_factor"),
	sharpeRatio: real("sharpe_ratio"),
	sortinoRatio: real("sortino_ratio"),
	maxDrawdownPct: real("max_drawdown_pct"),
	calmarRatio: real("calmar_ratio"),
	consistencyScore: integer("consistency_score"), // profitable weeks out of last 4
	updatedAt: text("updated_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const graduationEvents = sqliteTable("graduation_events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id").notNull(),
	event: text("event", {
		enum: ["graduated", "promoted", "demoted", "killed"],
	}).notNull(),
	fromTier: text("from_tier"),
	toTier: text("to_tier"),
	evidence: text("evidence"), // JSON: statistical summary
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── Evolution ───────────────────────────────────────────────────────────────

export const strategyMutations = sqliteTable("strategy_mutations", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	parentId: integer("parent_id").notNull(),
	childId: integer("child_id").notNull(),
	mutationType: text("mutation_type", {
		enum: ["parameter_tweak", "new_variant", "code_change"],
	}).notNull(),
	parameterDiff: text("parameter_diff"), // JSON
	parentSharpe: real("parent_sharpe"),
	childSharpe: real("child_sharpe"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── News ────────────────────────────────────────────────────────────────────

export const newsEvents = sqliteTable("news_events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	source: text("source").notNull(),
	headline: text("headline").notNull(),
	url: text("url"),
	symbols: text("symbols"), // JSON: string[]
	sentiment: real("sentiment"),
	confidence: real("confidence"),
	tradeable: integer("tradeable", { mode: "boolean" }),
	eventType: text("event_type"),
	urgency: text("urgency", { enum: ["low", "medium", "high"] }),
	classifiedAt: text("classified_at"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── Operational ─────────────────────────────────────────────────────────────

export const tokenUsage = sqliteTable("token_usage", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	job: text("job").notNull(),
	inputTokens: integer("input_tokens").notNull(),
	outputTokens: integer("output_tokens").notNull(),
	cacheCreationTokens: integer("cache_creation_tokens"),
	cacheReadTokens: integer("cache_read_tokens"),
	estimatedCostUsd: real("estimated_cost_usd").notNull(),
	status: text("status"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const agentLogs = sqliteTable("agent_logs", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	level: text("level", { enum: ["INFO", "WARN", "ERROR", "DECISION", "ACTION"] }).notNull(),
	phase: text("phase"),
	message: text("message").notNull(),
	data: text("data"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const dailySnapshots = sqliteTable("daily_snapshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	date: text("date").notNull().unique(),
	portfolioValue: real("portfolio_value").notNull(),
	cashBalance: real("cash_balance").notNull(),
	positionsValue: real("positions_value").notNull(),
	dailyPnl: real("daily_pnl").notNull(),
	dailyPnlPercent: real("daily_pnl_percent").notNull(),
	totalPnl: real("total_pnl").notNull(),
	paperStrategiesActive: integer("paper_strategies_active").notNull().default(0),
	liveStrategiesActive: integer("live_strategies_active").notNull().default(0),
	tradesCount: integer("trades_count").notNull().default(0),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const improvementProposals = sqliteTable("improvement_proposals", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	title: text("title").notNull(),
	description: text("description").notNull(),
	filesChanged: text("files_changed"),
	prUrl: text("pr_url"),
	status: text("status", {
		enum: ["PROPOSED", "PR_CREATED", "ISSUE_CREATED", "MERGED", "REJECTED"],
	})
		.notNull()
		.default("PROPOSED"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});
```

- [ ] **Step 5: Create src/db/migrate.ts**

```typescript
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./client.ts";

const db = getDb();
migrate(db, { migrationsFolder: "./drizzle/migrations" });
console.log("Migrations complete");
```

- [ ] **Step 6: Generate and run migrations**

```bash
bun run db:generate
bun run db:migrate
```

Expected: migration files created in `drizzle/migrations/`, migration runs without error.

- [ ] **Step 7: Run schema tests**

```bash
bun test tests/db/schema.test.ts
```

Expected: all 4 tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/db/ tests/db/ drizzle/
git commit -m "feat: add database schema and client for trader-v2"
```

---

### Task 5: Cost Tracking Utilities

**Files:**
- Create: `src/utils/cost.ts`
- Create: `src/utils/token-tracker.ts`
- Create: `src/utils/budget.ts`
- Create: `tests/utils/cost.test.ts`
- Create: `tests/utils/budget.test.ts`

- [ ] **Step 1: Write the failing cost test**

Create `tests/utils/cost.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { estimateCost, PRICING } from "../../src/utils/cost.ts";

describe("estimateCost", () => {
	test("calculates Haiku cost correctly", () => {
		const cost = estimateCost("news_classification", 1000, 200);
		// Haiku: (1000 * 1.0 + 200 * 5.0) / 1_000_000 = 0.0012
		expect(cost).toBeCloseTo(0.0012, 6);
	});

	test("calculates Sonnet cost correctly", () => {
		const cost = estimateCost("strategy_evolution", 5000, 1000);
		// Sonnet: (5000 * 3.0 + 1000 * 15.0) / 1_000_000 = 0.03
		expect(cost).toBeCloseTo(0.03, 6);
	});

	test("includes cache costs when provided", () => {
		const cost = estimateCost("news_classification", 500, 200, 300, 400);
		// Haiku: (500*1.0 + 200*5.0 + 300*1.25 + 400*0.1) / 1_000_000
		// = (500 + 1000 + 375 + 40) / 1_000_000 = 0.001915
		expect(cost).toBeCloseTo(0.001915, 6);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/utils/cost.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Create src/utils/cost.ts**

```typescript
export const PRICING = {
	sonnet: { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
	haiku: { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
} as const;

const HAIKU_JOBS = new Set([
	"news_classification",
	"graduation_review",
	"trade_review",
	"pattern_analysis",
	"daily_summary",
	"decision_scorer",
]);

type Tier = keyof typeof PRICING;

function getPricing(job: string): (typeof PRICING)[Tier] {
	if (HAIKU_JOBS.has(job)) return PRICING.haiku;
	return PRICING.sonnet;
}

export function estimateCost(
	job: string,
	inputTokens: number,
	outputTokens: number,
	cacheCreationTokens?: number,
	cacheReadTokens?: number,
): number {
	const p = getPricing(job);
	const cacheWrite = cacheCreationTokens ?? 0;
	const cacheRead = cacheReadTokens ?? 0;
	return (
		(inputTokens * p.input +
			outputTokens * p.output +
			cacheWrite * p.cacheWrite +
			cacheRead * p.cacheRead) /
		1_000_000
	);
}
```

- [ ] **Step 4: Run cost test**

```bash
bun test tests/utils/cost.test.ts
```

Expected: PASS

- [ ] **Step 5: Create src/utils/token-tracker.ts**

```typescript
import { getDb } from "../db/client.ts";
import { tokenUsage } from "../db/schema.ts";
import { estimateCost } from "./cost.ts";

export async function recordUsage(
	job: string,
	inputTokens: number,
	outputTokens: number,
	cacheCreationTokens?: number,
	cacheReadTokens?: number,
	status?: string,
): Promise<void> {
	const db = getDb();
	await db.insert(tokenUsage).values({
		job,
		inputTokens,
		outputTokens,
		cacheCreationTokens: cacheCreationTokens ?? null,
		cacheReadTokens: cacheReadTokens ?? null,
		estimatedCostUsd: estimateCost(
			job,
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
		),
		status: status ?? null,
	});
}
```

- [ ] **Step 6: Create src/utils/budget.ts**

```typescript
import { gte, sql } from "drizzle-orm";
import { getConfig } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import { tokenUsage } from "../db/schema.ts";

export async function getDailySpend(db?: DbClient): Promise<number> {
	const d = db ?? getDb();
	const todayStart = new Date();
	todayStart.setUTCHours(0, 0, 0, 0);

	const [row] = await d
		.select({ total: sql<number>`coalesce(sum(${tokenUsage.estimatedCostUsd}), 0)` })
		.from(tokenUsage)
		.where(gte(tokenUsage.createdAt, todayStart.toISOString()));

	return row?.total ?? 0;
}

export async function canAffordCall(estimatedCost: number, db?: DbClient): Promise<boolean> {
	const config = getConfig();
	if (config.DAILY_API_BUDGET_USD <= 0) return true;
	const d = db ?? getDb();
	const spent = await getDailySpend(d);
	return spent + estimatedCost < config.DAILY_API_BUDGET_USD;
}
```

- [ ] **Step 7: Write budget test**

Create `tests/utils/budget.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";

describe("budget", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("getDailySpend returns 0 with no usage", async () => {
		const { getDailySpend } = await import("../../src/utils/budget.ts");
		const spend = await getDailySpend();
		expect(spend).toBe(0);
	});

	test("canAffordCall returns true when budget is 0 (unlimited)", async () => {
		const { canAffordCall } = await import("../../src/utils/budget.ts");
		const result = await canAffordCall(1.0);
		expect(result).toBe(true);
	});
});
```

- [ ] **Step 8: Run all utils tests**

```bash
bun test tests/utils/
```

Expected: all PASS

- [ ] **Step 9: Commit**

```bash
git add src/utils/cost.ts src/utils/token-tracker.ts src/utils/budget.ts tests/utils/
git commit -m "feat: add cost tracking, token usage, and budget utilities"
```

---

### Task 6: FX Utility

**Files:**
- Create: `src/utils/fx.ts`

- [ ] **Step 1: Create src/utils/fx.ts**

Cherry-picked and simplified from v1. Uses Yahoo Finance for live FX rates with a 1-hour cache.

```typescript
import YahooFinance from "yahoo-finance2";
import { createChildLogger } from "./logger.ts";

const log = createChildLogger({ module: "fx" });

const yf = new YahooFinance();

interface FxCache {
	rate: number;
	timestamp: number;
}

const cache = new Map<string, FxCache>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getExchangeRate(from: string, to: string): Promise<number> {
	if (from === to) return 1;

	const key = `${from}${to}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.rate;
	}

	try {
		const symbol = `${from}${to}=X`;
		const quote = await yf.quote(symbol);
		if (quote.quoteType === "CURRENCY" && quote.regularMarketPrice) {
			const rate = quote.regularMarketPrice;
			cache.set(key, { rate, timestamp: Date.now() });
			return rate;
		}
	} catch (error) {
		log.warn({ from, to, error }, "FX rate fetch failed, using fallback");
	}

	// Hardcoded fallback rates
	const fallbacks: Record<string, number> = {
		GBPUSD: 1.27,
		USDGBP: 0.79,
	};
	return fallbacks[key] ?? 1;
}

export async function convertCurrency(
	amount: number,
	from: string,
	to: string,
): Promise<number> {
	const rate = await getExchangeRate(from, to);
	return amount * rate;
}

/** Get the friction cost for a round-trip trade on a given exchange */
export function getTradeFriction(exchange: string, side: "BUY" | "SELL"): number {
	switch (exchange) {
		case "LSE":
			// 0.5% stamp duty on buys only, ~0.1% spread
			return side === "BUY" ? 0.006 : 0.001;
		case "AIM":
			// 0% stamp duty, ~0.1% spread
			return 0.001;
		case "NASDAQ":
		case "NYSE":
			// ~0.2% FX spread each way
			return 0.002;
		default:
			return 0.002;
	}
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/fx.ts
git commit -m "feat: add FX conversion and trade friction utilities"
```

---

### Task 7: Quote Fetching & Caching

**Files:**
- Create: `src/data/quotes.ts`
- Create: `tests/data/quotes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/data/quotes.test.ts`:

```typescript
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { eq } from "drizzle-orm";

describe("quotes", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("upsertQuote inserts a new quote", async () => {
		const { upsertQuote } = await import("../../src/data/quotes.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await upsertQuote({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 185.5,
			bid: 185.4,
			ask: 185.6,
			volume: 50000000,
		});

		const rows = await db
			.select()
			.from(quotesCache)
			.where(eq(quotesCache.symbol, "AAPL"));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.last).toBe(185.5);
	});

	test("upsertQuote updates existing quote", async () => {
		const { upsertQuote } = await import("../../src/data/quotes.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await upsertQuote({ symbol: "AAPL", exchange: "NASDAQ", last: 185.5 });
		await upsertQuote({ symbol: "AAPL", exchange: "NASDAQ", last: 186.0 });

		const rows = await db
			.select()
			.from(quotesCache)
			.where(eq(quotesCache.symbol, "AAPL"));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.last).toBe(186.0);
	});

	test("getQuoteFromCache returns null for missing symbol", async () => {
		const { getQuoteFromCache } = await import("../../src/data/quotes.ts");
		const result = await getQuoteFromCache("ZZZZ", "NASDAQ");
		expect(result).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/data/quotes.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Create src/data/quotes.ts**

```typescript
import { eq, and } from "drizzle-orm";
import YahooFinance from "yahoo-finance2";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "quotes" });

const yf = new YahooFinance();

export interface QuoteData {
	symbol: string;
	exchange: string;
	last?: number | null;
	bid?: number | null;
	ask?: number | null;
	volume?: number | null;
	avgVolume?: number | null;
	changePercent?: number | null;
}

/** Upsert a quote into the cache */
export async function upsertQuote(data: QuoteData): Promise<void> {
	const db = getDb();
	const existing = await db
		.select()
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, data.symbol), eq(quotesCache.exchange, data.exchange)))
		.limit(1);

	if (existing.length > 0) {
		await db
			.update(quotesCache)
			.set({
				last: data.last ?? existing[0]!.last,
				bid: data.bid ?? existing[0]!.bid,
				ask: data.ask ?? existing[0]!.ask,
				volume: data.volume ?? existing[0]!.volume,
				avgVolume: data.avgVolume ?? existing[0]!.avgVolume,
				changePercent: data.changePercent ?? existing[0]!.changePercent,
				updatedAt: new Date().toISOString(),
			})
			.where(and(eq(quotesCache.symbol, data.symbol), eq(quotesCache.exchange, data.exchange)));
	} else {
		await db.insert(quotesCache).values({
			symbol: data.symbol,
			exchange: data.exchange,
			last: data.last ?? null,
			bid: data.bid ?? null,
			ask: data.ask ?? null,
			volume: data.volume ?? null,
			avgVolume: data.avgVolume ?? null,
			changePercent: data.changePercent ?? null,
		});
	}
}

/** Get a quote from the cache */
export async function getQuoteFromCache(
	symbol: string,
	exchange: string,
): Promise<typeof quotesCache.$inferSelect | null> {
	const db = getDb();
	const rows = await db
		.select()
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, symbol), eq(quotesCache.exchange, exchange)))
		.limit(1);
	return rows[0] ?? null;
}

/** Map exchange to Yahoo Finance suffix */
function yahooSymbol(symbol: string, exchange: string): string {
	if (exchange === "LSE" || exchange === "AIM") return `${symbol}.L`;
	return symbol; // NASDAQ/NYSE — no suffix
}

/** Fetch a fresh quote from Yahoo Finance and update the cache */
export async function refreshQuote(symbol: string, exchange: string): Promise<QuoteData | null> {
	try {
		const yahooSym = yahooSymbol(symbol, exchange);
		const quote = await yf.quote(yahooSym);

		if (!quote || !("regularMarketPrice" in quote)) {
			log.warn({ symbol, exchange }, "No quote data from Yahoo");
			return null;
		}

		const data: QuoteData = {
			symbol,
			exchange,
			last: quote.regularMarketPrice ?? null,
			bid: "bid" in quote ? (quote.bid as number | undefined) ?? null : null,
			ask: "ask" in quote ? (quote.ask as number | undefined) ?? null : null,
			volume: quote.regularMarketVolume ?? null,
			avgVolume: "averageDailyVolume3Month" in quote
				? (quote.averageDailyVolume3Month as number | undefined) ?? null
				: null,
			changePercent: quote.regularMarketChangePercent ?? null,
		};

		await upsertQuote(data);
		return data;
	} catch (error) {
		log.error({ symbol, exchange, error }, "Failed to refresh quote from Yahoo");
		return null;
	}
}

/** Refresh quotes for a list of symbols */
export async function refreshQuotes(
	symbols: Array<{ symbol: string; exchange: string }>,
): Promise<Map<string, QuoteData>> {
	const results = new Map<string, QuoteData>();

	for (const { symbol, exchange } of symbols) {
		const data = await refreshQuote(symbol, exchange);
		if (data) results.set(symbol, data);
		// Small delay to avoid Yahoo rate limiting
		await Bun.sleep(200);
	}

	log.info({ requested: symbols.length, fetched: results.size }, "Quote refresh complete");
	return results;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/data/quotes.test.ts
```

Expected: all 3 PASS (upsert tests use DB directly, no Yahoo calls)

- [ ] **Step 5: Commit**

```bash
git add src/data/quotes.ts tests/data/quotes.test.ts
git commit -m "feat: add quote fetching and caching via Yahoo Finance"
```

---

### Task 8: Email Reporting

**Files:**
- Create: `src/reporting/email.ts`

- [ ] **Step 1: Create src/reporting/email.ts**

Cherry-picked from v1:

```typescript
import { Resend } from "resend";
import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "email" });

let _resend: Resend | null = null;

function getResend(): Resend {
	if (!_resend) {
		_resend = new Resend(getConfig().RESEND_API_KEY);
	}
	return _resend;
}

export interface EmailOptions {
	subject: string;
	html: string;
}

export async function sendEmail(options: EmailOptions): Promise<void> {
	const config = getConfig();

	if (config.NODE_ENV === "test") {
		log.debug({ subject: options.subject }, "Skipping email in test mode");
		return;
	}

	try {
		const resend = getResend();
		await resend.emails.send({
			from: config.ALERT_EMAIL_FROM,
			to: config.ALERT_EMAIL_TO,
			subject: options.subject,
			html: options.html,
		});
		log.info({ subject: options.subject }, "Email sent");
	} catch (error) {
		log.error({ error, subject: options.subject }, "Failed to send email");
	}
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/reporting/email.ts
git commit -m "feat: add email reporting via Resend (cherry-pick from v1)"
```

---

### Task 9: Scheduler

**Files:**
- Create: `src/scheduler/cron.ts`
- Create: `src/scheduler/jobs.ts`
- Create: `tests/scheduler/cron.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/scheduler/cron.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("scheduler", () => {
	test("jobs module exports runJob function", async () => {
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		expect(typeof runJob).toBe("function");
	});

	test("runJob handles quote_refresh job", async () => {
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		// Should not throw — quote_refresh with no symbols just logs and returns
		await runJob("quote_refresh");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/scheduler/cron.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Create src/scheduler/jobs.ts**

```typescript
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "scheduler-jobs" });

export type JobName =
	| "quote_refresh"
	| "strategy_evaluation"
	| "daily_summary"
	| "weekly_digest"
	| "strategy_evolution"
	| "trade_review"
	| "pattern_analysis"
	| "earnings_calendar_sync"
	| "heartbeat";

let jobRunning = false;
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function runJob(name: JobName): Promise<void> {
	if (jobRunning) {
		log.debug({ job: name }, "Skipping — previous job still running");
		return;
	}

	jobRunning = true;
	const start = Date.now();
	log.info({ job: name }, "Job starting");

	try {
		const jobPromise = executeJob(name);
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error(`Job ${name} timed out after ${JOB_TIMEOUT_MS / 60000}min`)),
				JOB_TIMEOUT_MS,
			);
		});

		await Promise.race([jobPromise, timeoutPromise]);
		log.info({ job: name, durationMs: Date.now() - start }, "Job completed");
	} catch (error) {
		log.error({ job: name, error, durationMs: Date.now() - start }, "Job failed");
	} finally {
		jobRunning = false;
	}
}

async function executeJob(name: JobName): Promise<void> {
	switch (name) {
		case "quote_refresh": {
			// Phase 1: refresh quotes for all symbols in quotes_cache
			const { refreshQuotesForAllCached } = await import("./quote-refresh.ts");
			await refreshQuotesForAllCached();
			break;
		}

		case "heartbeat": {
			const { sendEmail } = await import("../reporting/email.ts");
			const uptimeHrs = (process.uptime() / 3600).toFixed(1);
			await sendEmail({
				subject: `Heartbeat: Trader v2 alive — uptime ${uptimeHrs}h`,
				html: `<p>Trader v2 is running. Uptime: ${uptimeHrs} hours. Time: ${new Date().toISOString()}</p>`,
			});
			break;
		}

		// Stubs for future phases — log and return
		case "strategy_evaluation":
		case "daily_summary":
		case "weekly_digest":
		case "strategy_evolution":
		case "trade_review":
		case "pattern_analysis":
		case "earnings_calendar_sync":
			log.info({ job: name }, "Job not yet implemented (future phase)");
			break;
	}
}
```

- [ ] **Step 4: Create src/scheduler/quote-refresh.ts**

```typescript
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { refreshQuote } from "../data/quotes.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "quote-refresh" });

/** Refresh quotes for all symbols currently in the cache */
export async function refreshQuotesForAllCached(): Promise<void> {
	const db = getDb();
	const cached = await db
		.select({ symbol: quotesCache.symbol, exchange: quotesCache.exchange })
		.from(quotesCache);

	if (cached.length === 0) {
		log.info("No symbols in quotes cache — nothing to refresh");
		return;
	}

	let refreshed = 0;
	for (const { symbol, exchange } of cached) {
		const result = await refreshQuote(symbol, exchange);
		if (result) refreshed++;
		await Bun.sleep(200);
	}

	log.info({ total: cached.length, refreshed }, "Quote refresh complete");
}
```

- [ ] **Step 5: Create src/scheduler/cron.ts**

```typescript
import cron, { type ScheduledTask } from "node-cron";
import { createChildLogger } from "../utils/logger.ts";
import { runJob } from "./jobs.ts";

const log = createChildLogger({ module: "scheduler" });

const tasks: ScheduledTask[] = [];

export function startScheduler(): void {
	// Quote refresh every 10 minutes during US + UK market hours (08:00-21:00 UK)
	tasks.push(
		cron.schedule("*/10 8-20 * * 1-5", () => runJob("quote_refresh"), {
			timezone: "Europe/London",
		}),
	);

	// Heartbeat at 07:00 weekdays
	tasks.push(
		cron.schedule("0 7 * * 1-5", () => runJob("heartbeat"), {
			timezone: "Europe/London",
		}),
	);

	// Stubs for future phases — will be activated as phases are built
	// Strategy evaluation: every 10 min during market hours
	// Daily summary: 21:05 weekdays
	// Weekly digest: 17:30 Friday
	// Strategy evolution: 20:00 Sunday
	// Trade review: 17:15 weekdays
	// Pattern analysis: 19:00 Wednesday + Friday

	log.info({ jobCount: tasks.length }, "Scheduler started");
}

export function stopScheduler(): void {
	for (const task of tasks) {
		task.stop();
	}
	tasks.length = 0;
	log.info("Scheduler stopped");
}
```

- [ ] **Step 6: Run tests**

```bash
bun test tests/scheduler/cron.test.ts
```

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/ tests/scheduler/
git commit -m "feat: add scheduler with quote refresh and heartbeat jobs"
```

---

### Task 10: Entry Point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Create src/index.ts**

```typescript
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getConfig } from "./config.ts";
import { closeDb, getDb } from "./db/client.ts";
import { sendEmail } from "./reporting/email.ts";
import { startScheduler, stopScheduler } from "./scheduler/cron.ts";
import { getLogger } from "./utils/logger.ts";

const log = getLogger();

async function boot() {
	const config = getConfig();
	log.info({ env: config.NODE_ENV }, "Trader v2 starting");

	// Initialize database and run migrations
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
	log.info("Database connected and migrated");

	// Start the scheduler
	startScheduler();
	log.info("Scheduler started — trader v2 is running");
}

async function shutdown(signal: string) {
	log.info({ signal }, "Shutting down...");
	stopScheduler();
	closeDb();
	log.info("Shutdown complete");
	process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (error) => {
	log.fatal({ error }, "Uncaught exception");
	sendEmail({
		subject: "CRITICAL: Trader v2 uncaught exception",
		html: `<pre>${String(error?.stack ?? error)}</pre>`,
	}).finally(() => shutdown("uncaughtException"));
});

process.on("unhandledRejection", (reason) => {
	log.error({ reason }, "Unhandled rejection");
});

boot().catch(async (error) => {
	log.fatal({ error }, "Boot failed");
	await sendEmail({
		subject: "CRITICAL: Trader v2 boot failed",
		html: `<pre>${String(error?.stack ?? error)}</pre>`,
	});
	process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 3: Verify the app boots (dry run)**

```bash
cd ~/Documents/Projects/trader-v2
ANTHROPIC_API_KEY=test RESEND_API_KEY=test ALERT_EMAIL_TO=test@test.com NODE_ENV=development bun src/index.ts &
sleep 2
kill %1
```

Expected: logs showing "Trader v2 starting", "Database connected", "Scheduler started". Then clean shutdown.

- [ ] **Step 4: Run full test suite**

```bash
bun test
```

Expected: all tests pass

- [ ] **Step 5: Run lint**

```bash
bun run lint
```

Expected: no errors (warnings OK)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point — trader v2 boots, migrates, and starts scheduler"
```

---

## Phase 1 Complete Checklist

After all tasks, verify:

- [ ] `bun test` — all tests pass
- [ ] `bun run typecheck` — no errors
- [ ] `bun run lint` — no errors
- [ ] App boots and shuts down cleanly
- [ ] Quote refresh job can fetch and cache a real Yahoo quote (manual test)

## What's Next

**Phase 2: Paper Lab** — strategy engine, signal expression parser, paper trading loop. This is where the system starts generating data.
