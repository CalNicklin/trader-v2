import { describe, expect, test } from "bun:test";
import { validateMutation } from "../../src/evolution/validator";

const parentStrategy = {
	id: 1,
	name: "news_sentiment_mr_v1",
	parameters: { sentiment_threshold: 0.7, rsi_oversold: 30, hold_days: 3 },
	signals: {
		entry_long: "news_sentiment > 0.7 AND rsi14 < 30",
		exit: "hold_days >= 3",
	},
	universe: ["AAPL", "MSFT"],
	status: "paper",
	generation: 1,
	parentStrategyId: null,
	createdBy: "seed",
	metrics: null,
	recentTrades: [],
	virtualBalance: 10000,
	insightSummary: [],
	suggestedActions: [],
};

describe("structural mutation validation", () => {
	test("accepts valid structural mutation with new signals", () => {
		const proposal = {
			parentId: 1,
			type: "structural" as const,
			name: "volume_breakout_v1",
			description: "Breakout on volume surge with ATR filter",
			parameters: { volume_ratio_min: 2.0, atr_multiplier: 1.5 },
			signals: {
				entry_long: "volume_ratio > 2.0 AND change_percent > 0 AND atr14 > 0.5",
				exit: "hold_days >= 2 OR pnl_pct < -3",
			},
			universe: ["AAPL", "MSFT", "GOOGL"],
			reasoning: "Volume breakouts capture momentum shifts",
		};
		const result = validateMutation(proposal, parentStrategy, []);
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.mutation?.type).toBe("structural");
		}
	});

	test("rejects structural mutation without signals", () => {
		const proposal = {
			parentId: 1,
			type: "structural" as const,
			name: "no_signals_v1",
			description: "Missing signals",
			parameters: { volume_ratio_min: 2.0 },
			reasoning: "Test",
		};
		const result = validateMutation(proposal, parentStrategy, []);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("signal");
		}
	});

	test("rejects structural mutation with more than 5 parameters", () => {
		const proposal = {
			parentId: 1,
			type: "structural" as const,
			name: "too_many_params",
			description: "Overfit city",
			parameters: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
			signals: { entry_long: "last > 0", exit: "hold_days >= 1" },
			reasoning: "Test",
		};
		const result = validateMutation(proposal, parentStrategy, []);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("parameter");
		}
	});

	test("validates signal expressions parse correctly", () => {
		const proposal = {
			parentId: 1,
			type: "structural" as const,
			name: "bad_expr_v1",
			description: "Invalid expression",
			parameters: { threshold: 0.5 },
			signals: {
				entry_long: "this is not a valid expression!!!",
				exit: "hold_days >= 1",
			},
			reasoning: "Test",
		};
		const result = validateMutation(proposal, parentStrategy, []);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("signal");
		}
	});

	test("structural mutation does not require params within PARAMETER_RANGES", () => {
		const proposal = {
			parentId: 1,
			type: "structural" as const,
			name: "custom_params_v1",
			description: "Custom param names",
			parameters: { volume_ratio_min: 2.5, breakout_pct: 3.0 },
			signals: {
				entry_long: "volume_ratio > 2.5 AND change_percent > 3.0",
				exit: "hold_days >= 2",
			},
			reasoning: "New indicator combination",
		};
		const result = validateMutation(proposal, parentStrategy, []);
		expect(result.valid).toBe(true);
	});
});
