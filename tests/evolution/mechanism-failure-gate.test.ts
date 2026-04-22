import { beforeEach, describe, expect, test } from "bun:test";

const baseParent = () => ({
	id: 3,
	name: "earnings_drift_v1",
	status: "paper",
	generation: 1,
	parentStrategyId: null,
	createdBy: "seed",
	parameters: {
		stop_loss_pct: 5,
		hold_days: 5,
		tone_score_min: 0.6,
	},
	signals: { entry_long: "x", exit: "y" },
	universe: ["AAPL"],
	metrics: null,
	recentTrades: [],
	virtualBalance: 10_000,
	insightSummary: [],
	suggestedActions: [],
	mechanismFailureStats: { totalReviews: 0, failureRate: 0 },
});

describe("mechanism-failure tag constants (TRA-10)", () => {
	test("MECHANISM_FAILURE_TAGS covers filter/catalyst/regime/fundamental", async () => {
		const { MECHANISM_FAILURE_TAGS } = await import("../../src/evolution/mechanism-failure.ts");
		expect(MECHANISM_FAILURE_TAGS.has("filter_failure")).toBe(true);
		expect(MECHANISM_FAILURE_TAGS.has("catalyst_ignored")).toBe(true);
		expect(MECHANISM_FAILURE_TAGS.has("fundamental_gap")).toBe(true);
		expect(MECHANISM_FAILURE_TAGS.has("regime_mismatch")).toBe(true);
		// Not a mechanism failure — these are timing/sizing:
		expect(MECHANISM_FAILURE_TAGS.has("early_exit")).toBe(false);
		expect(MECHANISM_FAILURE_TAGS.has("stop_too_tight")).toBe(false);
	});

	test("threshold + min-reviews constants match insight-review amendment", async () => {
		const { MECHANISM_FAILURE_RATE_THRESHOLD, MECHANISM_FAILURE_MIN_REVIEWS } = await import(
			"../../src/evolution/mechanism-failure.ts"
		);
		expect(MECHANISM_FAILURE_RATE_THRESHOLD).toBe(0.5);
		expect(MECHANISM_FAILURE_MIN_REVIEWS).toBe(4);
	});
});

describe("getMechanismFailureStats (TRA-10)", () => {
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

	test("returns zero rate when no reviews exist", async () => {
		const { getMechanismFailureStats } = await import("../../src/evolution/mechanism-failure.ts");
		const stats = await getMechanismFailureStats(999);
		expect(stats.totalReviews).toBe(0);
		expect(stats.failureRate).toBe(0);
	});

	test("counts only non-quarantined trade_review rows in the lookback window", async () => {
		const { getMechanismFailureStats } = await import("../../src/evolution/mechanism-failure.ts");
		const { tradeInsights } = await import("../../src/db/schema.ts");
		const now = new Date("2026-04-22T13:00:00Z");
		const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
		const old = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();

		await db.insert(tradeInsights).values([
			// Recent + mechanism failure + fresh (not quarantined) → counted
			{
				strategyId: 1,
				insightType: "trade_review",
				tags: JSON.stringify(["filter_failure"]),
				observation: "x",
				confidence: 0.9,
				quarantined: 0,
				createdAt: recent,
			},
			{
				strategyId: 1,
				insightType: "trade_review",
				tags: JSON.stringify(["catalyst_ignored", "fundamental_gap"]),
				observation: "x",
				confidence: 0.9,
				quarantined: 0,
				createdAt: recent,
			},
			// Recent + no failure tag → counted in denominator only
			{
				strategyId: 1,
				insightType: "trade_review",
				tags: JSON.stringify(["early_exit"]),
				observation: "x",
				confidence: 0.9,
				quarantined: 0,
				createdAt: recent,
			},
			{
				strategyId: 1,
				insightType: "trade_review",
				tags: JSON.stringify([]),
				observation: "x",
				confidence: 0.9,
				quarantined: 0,
				createdAt: recent,
			},
			// Recent + mechanism failure + quarantined → excluded
			{
				strategyId: 1,
				insightType: "trade_review",
				tags: JSON.stringify(["filter_failure"]),
				observation: "pre-fix",
				confidence: 0.9,
				quarantined: 1,
				createdAt: recent,
			},
			// Old mechanism failure → excluded by lookback
			{
				strategyId: 1,
				insightType: "trade_review",
				tags: JSON.stringify(["filter_failure"]),
				observation: "old",
				confidence: 0.9,
				quarantined: 0,
				createdAt: old,
			},
			// Non-trade_review → ignored
			{
				strategyId: 1,
				insightType: "pattern_analysis",
				tags: JSON.stringify(["filter_failure"]),
				observation: "pattern",
				confidence: 0.9,
				quarantined: 0,
				createdAt: recent,
			},
		]);

		const stats = await getMechanismFailureStats(1, now);
		// 4 in-window non-quarantined trade_review rows; 2 have failure tags
		expect(stats.totalReviews).toBe(4);
		expect(stats.failureRate).toBeCloseTo(0.5, 5);
	});
});

describe("validateMutation — TRA-10 ratio gate", () => {
	test("rejects mutation when parent failureRate ≥ 0.5 and reviews ≥ 4", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const parent = baseParent();
		parent.mechanismFailureStats = { totalReviews: 6, failureRate: 0.67 };
		const result = validateMutation(
			{
				parentId: 3,
				type: "parameter_tweak",
				name: "earnings_drift_v2",
				description: "",
				parameters: { stop_loss_pct: 5, hold_days: 6, tone_score_min: 0.6 },
				reasoning: "test",
			},
			parent,
			[],
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toMatch(/mechanism[- ]failure/i);
		}
	});

	test("allows mutation when parent failureRate ≥ 0.5 but reviews < 4 (insufficient evidence)", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const parent = baseParent();
		parent.mechanismFailureStats = { totalReviews: 3, failureRate: 1.0 };
		const result = validateMutation(
			{
				parentId: 3,
				type: "parameter_tweak",
				name: "earnings_drift_v2",
				description: "",
				parameters: { stop_loss_pct: 5, hold_days: 6, tone_score_min: 0.6 },
				reasoning: "test",
			},
			parent,
			[],
		);
		expect(result.valid).toBe(true);
	});

	test("allows mutation when rate is below threshold", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const parent = baseParent();
		parent.mechanismFailureStats = { totalReviews: 10, failureRate: 0.3 };
		const result = validateMutation(
			{
				parentId: 3,
				type: "parameter_tweak",
				name: "earnings_drift_v2",
				description: "",
				parameters: { stop_loss_pct: 5, hold_days: 7, tone_score_min: 0.6 },
				reasoning: "test",
			},
			parent,
			[],
		);
		expect(result.valid).toBe(true);
	});
});

describe("validateMutation — TRA-10 filter-removal rule", () => {
	test("rejects child that sets a parent's positive numeric filter to 0", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const result = validateMutation(
			{
				parentId: 3,
				type: "parameter_tweak",
				name: "earnings_drift_v2",
				description: "",
				// tone_score_min loosened 0.6 → 0 (Strategy 5's actual pathology)
				parameters: { stop_loss_pct: 5, hold_days: 5, tone_score_min: 0 },
				reasoning: "test",
			},
			baseParent(),
			[],
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toMatch(/tone_score_min/);
			expect(result.reason).toMatch(/removes|loosens|zero/i);
		}
	});

	test("rejects child that omits a parent's positive numeric filter entirely", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const result = validateMutation(
			{
				parentId: 3,
				type: "parameter_tweak",
				name: "earnings_drift_v2",
				description: "",
				// tone_score_min dropped entirely
				parameters: { stop_loss_pct: 5, hold_days: 5 },
				reasoning: "test",
			},
			baseParent(),
			[],
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toMatch(/tone_score_min/);
		}
	});

	test("allows child that tightens (not loosens) a filter", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const result = validateMutation(
			{
				parentId: 3,
				type: "parameter_tweak",
				name: "earnings_drift_v2",
				description: "",
				parameters: { stop_loss_pct: 5, hold_days: 5, tone_score_min: 0.8 },
				reasoning: "test",
			},
			baseParent(),
			[],
		);
		expect(result.valid).toBe(true);
	});

	test("rule does not apply to structural mutations (they redefine signals)", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const result = validateMutation(
			{
				parentId: 3,
				type: "structural",
				name: "earnings_drift_vNext",
				description: "",
				parameters: { stop_loss_pct: 5 },
				signals: { entry_long: "foo" },
				reasoning: "test",
			},
			baseParent(),
			[],
		);
		expect(result.valid).toBe(true);
	});
});
