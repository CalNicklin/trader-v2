import { describe, expect, it } from "bun:test";
import type { MutationProposal, StrategyPerformance } from "../../src/evolution/types";
import { clampParameters, PARAMETER_RANGES, validateMutation } from "../../src/evolution/validator";

function makeParent(overrides: Partial<StrategyPerformance> = {}): StrategyPerformance {
	return {
		id: 1,
		name: "Parent Strategy",
		status: "active_paper",
		generation: 1,
		parentStrategyId: null,
		createdBy: "human",
		parameters: { stop_loss_pct: 3, hold_days: 5, position_size_pct: 10 },
		signals: { entry_long: "rsi < 30", exit: "rsi > 60" },
		universe: ["AAPL", "MSFT"],
		metrics: null,
		recentTrades: [],
		virtualBalance: 10000,
		insightSummary: [],
		...overrides,
	};
}

function makeProposal(overrides: Partial<MutationProposal> = {}): MutationProposal {
	return {
		parentId: 1,
		type: "parameter_tweak",
		name: "Child Strategy",
		description: "A tweaked version",
		parameters: { stop_loss_pct: 4, hold_days: 7, position_size_pct: 12 },
		reasoning: "Testing",
		...overrides,
	};
}

describe("clampParameters", () => {
	it("clamps known parameters to their ranges", () => {
		const result = clampParameters({
			stop_loss_pct: 50, // max 10
			hold_days: 0, // min 1
			rsi_oversold: 10, // min 15
			rsi_overbought: 99, // max 85
		});
		expect(result.stop_loss_pct).toBe(PARAMETER_RANGES.stop_loss_pct.max);
		expect(result.hold_days).toBe(PARAMETER_RANGES.hold_days.min);
		expect(result.rsi_oversold).toBe(PARAMETER_RANGES.rsi_oversold.min);
		expect(result.rsi_overbought).toBe(PARAMETER_RANGES.rsi_overbought.max);
	});

	it("passes through unknown parameters unchanged", () => {
		const result = clampParameters({
			custom_thing: 999,
			another_param: -50,
		});
		expect(result.custom_thing).toBe(999);
		expect(result.another_param).toBe(-50);
	});
});

describe("validateMutation", () => {
	it("accepts valid parameter_tweak and builds correct parameterDiff", () => {
		const parent = makeParent();
		const proposal = makeProposal({
			parameters: { stop_loss_pct: 4, hold_days: 7, position_size_pct: 12 },
		});

		const result = validateMutation(proposal, parent, []);
		expect(result.valid).toBe(true);
		if (!result.valid) return;

		const { mutation } = result;
		expect(mutation.parentId).toBe(1);
		expect(mutation.type).toBe("parameter_tweak");
		expect(mutation.name).toBe("Child Strategy");
		expect(mutation.parameters.stop_loss_pct).toBe(4);
		expect(mutation.parameterDiff.stop_loss_pct).toEqual({ from: 3, to: 4 });
		expect(mutation.parameterDiff.hold_days).toEqual({ from: 5, to: 7 });
		expect(mutation.parameterDiff.position_size_pct).toEqual({ from: 10, to: 12 });
		// signals/universe fall back to parent
		expect(mutation.signals).toEqual(parent.signals);
		expect(mutation.universe).toEqual(parent.universe);
	});

	it("rejects proposals with more than 5 parameters", () => {
		const parent = makeParent();
		const proposal = makeProposal({
			parameters: {
				stop_loss_pct: 4,
				hold_days: 7,
				position_size_pct: 12,
				sentiment_threshold: 0.5,
				rsi_oversold: 30,
				rsi_overbought: 70, // 6 parameters
			},
		});

		const result = validateMutation(proposal, parent, []);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.reason).toMatch(/Too many parameters/);
	});

	it("rejects near-duplicate of existing strategy", () => {
		const parent = makeParent();
		const existingChild = makeParent({
			id: 2,
			name: "Existing Child",
			parameters: { stop_loss_pct: 4, hold_days: 7, position_size_pct: 12 },
		});
		// Proposal with identical parameters to existingChild
		const proposal = makeProposal({
			parameters: { stop_loss_pct: 4, hold_days: 7, position_size_pct: 12 },
		});

		const result = validateMutation(proposal, parent, [existingChild]);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.reason).toMatch(/Near-duplicate/);
	});

	it("clamps out-of-range parameters before validation", () => {
		const parent = makeParent({
			parameters: { stop_loss_pct: 3, hold_days: 5 },
		});
		const proposal = makeProposal({
			parameters: {
				stop_loss_pct: 99, // will be clamped to 10
				hold_days: 15,
			},
		});

		const result = validateMutation(proposal, parent, []);
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.mutation.parameters.stop_loss_pct).toBe(PARAMETER_RANGES.stop_loss_pct.max);
		expect(result.mutation.parameterDiff.stop_loss_pct).toEqual({ from: 3, to: 10 });
	});

	it("rejects new_variant without signals", () => {
		const parent = makeParent();
		const proposal = makeProposal({
			type: "new_variant",
			signals: undefined,
		});

		const result = validateMutation(proposal, parent, []);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.reason).toMatch(/new_variant.*signals/i);
	});

	it("accepts new_variant with signals", () => {
		const parent = makeParent();
		const proposal = makeProposal({
			type: "new_variant",
			parameters: { stop_loss_pct: 5, hold_days: 10, position_size_pct: 15 },
			signals: { entry_long: "sentiment > 0.8", exit: "hold_days > 10" },
			universe: ["TSLA", "NVDA"],
		});

		const result = validateMutation(proposal, parent, []);
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.mutation.signals).toEqual({
			entry_long: "sentiment > 0.8",
			exit: "hold_days > 10",
		});
		expect(result.mutation.universe).toEqual(["TSLA", "NVDA"]);
	});

	it("parameterDiff only includes changed parameters", () => {
		const parent = makeParent({
			parameters: { stop_loss_pct: 3, hold_days: 5, position_size_pct: 10 },
		});
		// Only change hold_days
		const proposal = makeProposal({
			parameters: { stop_loss_pct: 3, hold_days: 8, position_size_pct: 10 },
		});

		const result = validateMutation(proposal, parent, []);
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(Object.keys(result.mutation.parameterDiff)).toEqual(["hold_days"]);
		expect(result.mutation.parameterDiff.hold_days).toEqual({ from: 5, to: 8 });
	});
});
