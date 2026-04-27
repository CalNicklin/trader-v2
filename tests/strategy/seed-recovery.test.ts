import { beforeEach, describe, expect, it } from "bun:test";
import { evalExpr } from "../../src/strategy/expr-eval.ts";

describe("recovery seeds", () => {
	let RECOVERY_SEEDS: typeof import("../../src/strategy/seed.ts").RECOVERY_SEEDS;

	beforeEach(async () => {
		const mod = await import("../../src/strategy/seed.ts");
		RECOVERY_SEEDS = mod.RECOVERY_SEEDS;
	});

	it("has at least 2 recovery seeds", () => {
		expect(RECOVERY_SEEDS.length).toBeGreaterThanOrEqual(2);
	});

	it("every recovery seed has stop_loss_pct in parameters", () => {
		for (const seed of RECOVERY_SEEDS) {
			const params = JSON.parse(seed.parameters);
			expect(params.stop_loss_pct).toBeGreaterThan(0);
		}
	});

	it("every recovery seed has valid parseable signal expressions", () => {
		for (const seed of RECOVERY_SEEDS) {
			const signals = JSON.parse(seed.signals);
			const hasEntry = signals.entry_long || signals.entry_short;
			expect(hasEntry).toBeTruthy();

			for (const expr of Object.values(signals)) {
				expect(() => evalExpr(expr as string, {})).not.toThrow();
			}
		}
	});

	it("every recovery seed has a non-empty universe", () => {
		for (const seed of RECOVERY_SEEDS) {
			const universe: string[] = JSON.parse(seed.universe);
			expect(universe.length).toBeGreaterThanOrEqual(5);
		}
	});

	it("recovery seeds have distinct names", () => {
		const names = RECOVERY_SEEDS.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("recovery seeds use createdBy 'seed:recovery'", () => {
		for (const seed of RECOVERY_SEEDS) {
			expect(seed.createdBy).toBe("seed:recovery");
		}
	});
});

describe("ensurePopulationFloor", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { strategies } = await import("../../src/db/schema.ts");
		await db.delete(strategies);
	});

	it("inserts recovery seeds when population is below floor", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { ensurePopulationFloor } = await import("../../src/strategy/seed.ts");
		const { eq } = await import("drizzle-orm");

		await db.insert(strategies).values({
			name: "existing-paper",
			description: "Existing strategy",
			parameters: JSON.stringify({ hold_days: 3 }),
			signals: JSON.stringify({ entry_long: "rsi14 < 30" }),
			universe: JSON.stringify(["AAPL"]),
			status: "paper" as const,
			virtualBalance: 10000,
			generation: 1,
		});

		const inserted = await ensurePopulationFloor();
		expect(inserted).toBeGreaterThan(0);

		const allPaper = await db.select().from(strategies).where(eq(strategies.status, "paper")).all();
		expect(allPaper.length).toBeGreaterThanOrEqual(3);
	});

	it("does nothing when population is at or above floor", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { ensurePopulationFloor } = await import("../../src/strategy/seed.ts");

		for (let i = 0; i < 4; i++) {
			await db.insert(strategies).values({
				name: `paper-${i}`,
				description: `Strategy ${i}`,
				parameters: JSON.stringify({ hold_days: i + 1 }),
				signals: JSON.stringify({ entry_long: `rsi14 < ${30 + i}` }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			});
		}

		const inserted = await ensurePopulationFloor();
		expect(inserted).toBe(0);
	});

	it("skips seeds that already exist by name", async () => {
		const { strategies } = await import("../../src/db/schema.ts");
		const { ensurePopulationFloor, RECOVERY_SEEDS } = await import("../../src/strategy/seed.ts");
		const { eq } = await import("drizzle-orm");

		await db.insert(strategies).values({
			name: RECOVERY_SEEDS[0]!.name,
			description: "Already exists but retired",
			parameters: JSON.stringify({ hold_days: 3 }),
			signals: JSON.stringify({ entry_long: "rsi14 < 30" }),
			universe: JSON.stringify(["AAPL"]),
			status: "retired" as const,
			virtualBalance: 0,
			generation: 1,
		});

		await ensurePopulationFloor();

		const withName = await db
			.select()
			.from(strategies)
			.where(eq(strategies.name, RECOVERY_SEEDS[0]!.name))
			.all();
		expect(withName.length).toBe(1);
		expect(withName[0]!.status).toBe("retired");
	});
});
