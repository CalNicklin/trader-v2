import { describe, expect, test } from "bun:test";

describe("archetype stop-loss floor (TRA-8)", () => {
	test("inferArchetype classifies by strategy name convention", async () => {
		const { inferArchetype } = await import("../../src/evolution/archetype.ts");
		expect(inferArchetype("news_sentiment_mr_v1")).toBe("mean_reversion");
		expect(inferArchetype("gap_fade_v1")).toBe("mean_reversion");
		expect(inferArchetype("earnings_drift_v1")).toBe("earnings_drift");
		expect(inferArchetype("earnings_drift_aggressive_v1")).toBe("earnings_drift");
		expect(inferArchetype("momentum_breakout_v1")).toBe("breakout");
		expect(inferArchetype("momentum_rsi_v1")).toBe("momentum");
		expect(inferArchetype("range_breakout_v2")).toBe("breakout");
	});

	test("inferArchetype defaults to mean_reversion for unrecognised names", async () => {
		const { inferArchetype } = await import("../../src/evolution/archetype.ts");
		expect(inferArchetype("some_new_strategy_v1")).toBe("mean_reversion");
		expect(inferArchetype("")).toBe("mean_reversion");
	});

	test("ARCHETYPE_STOP_LOSS_FLOOR matches insight-review ranks", async () => {
		const { ARCHETYPE_STOP_LOSS_FLOOR } = await import("../../src/evolution/archetype.ts");
		expect(ARCHETYPE_STOP_LOSS_FLOOR.mean_reversion).toBe(2);
		expect(ARCHETYPE_STOP_LOSS_FLOOR.earnings_drift).toBe(5);
		expect(ARCHETYPE_STOP_LOSS_FLOOR.momentum).toBe(3);
		expect(ARCHETYPE_STOP_LOSS_FLOOR.breakout).toBe(4);
	});
});

describe("validator — TRA-8 per-archetype stop_loss floor", () => {
	const baseParent = {
		id: 3,
		name: "earnings_drift_v1",
		status: "paper",
		generation: 1,
		parentStrategyId: null,
		createdBy: "seed",
		parameters: { stop_loss_pct: 5, hold_days: 5 },
		signals: { entry_long: "x", entry_short: null, exit: "y" },
		universe: ["AAPL"],
		metrics: null,
		recentTrades: [],
		virtualBalance: 10_000,
		insightSummary: [],
		suggestedActions: [],
	};

	test("rejects earnings_drift child with stop_loss_pct below 5% floor", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const result = validateMutation(
			{
				parentId: 3,
				type: "parameter_tweak",
				name: "earnings_drift_v2",
				description: "",
				parameters: { stop_loss_pct: 3, hold_days: 5 },
			},
			baseParent,
			[],
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toMatch(/earnings_drift/);
			expect(result.reason).toMatch(/floor.*5/);
		}
	});

	test("accepts earnings_drift child with stop_loss_pct at the floor", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const result = validateMutation(
			{
				parentId: 3,
				type: "parameter_tweak",
				name: "earnings_drift_v2",
				description: "",
				parameters: { stop_loss_pct: 5, hold_days: 6 },
			},
			baseParent,
			[],
		);
		expect(result.valid).toBe(true);
	});

	test("rejects mean_reversion child with stop_loss_pct below 2% floor", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const mrParent = { ...baseParent, id: 1, name: "news_sentiment_mr_v1" };
		const result = validateMutation(
			{
				parentId: 1,
				type: "parameter_tweak",
				name: "news_sentiment_mr_v2",
				description: "",
				parameters: { stop_loss_pct: 1, hold_days: 3 },
			},
			mrParent,
			[],
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toMatch(/mean_reversion/);
		}
	});

	test("still rejects stop_loss_pct = 0 outright", async () => {
		const { validateMutation } = await import("../../src/evolution/validator.ts");
		const result = validateMutation(
			{
				parentId: 3,
				type: "parameter_tweak",
				name: "earnings_drift_v2",
				description: "",
				parameters: { stop_loss_pct: 0, hold_days: 5 },
			},
			baseParent,
			[],
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toMatch(/non-zero/);
		}
	});
});
