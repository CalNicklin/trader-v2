import { describe, expect, test } from "bun:test";
import type { EvolutionReference } from "../../src/evals/evolution/tasks.ts";
import type { MutationProposal } from "../../src/evolution/types.ts";

function makeProposal(overrides: Partial<MutationProposal> = {}): MutationProposal {
	return {
		parentId: 1,
		type: "parameter_tweak",
		name: "Test Proposal",
		description: "A test proposal",
		parameters: { hold_days: 5, position_size_pct: 10, stop_loss_pct: 3 },
		reasoning: "Testing",
		...overrides,
	};
}

function makeReference(overrides: Partial<EvolutionReference> = {}): EvolutionReference {
	return {
		minProposals: 1,
		maxProposals: 5,
		...overrides,
	};
}

describe("proposalCountGrader", () => {
	test("passes when count is within range", async () => {
		const { proposalCountGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal(), makeProposal()];
		const result = await proposalCountGrader.grade(
			output,
			makeReference({ minProposals: 1, maxProposals: 3 }),
		);
		expect(result.pass).toBe(true);
		expect(result.score).toBe(1);
	});

	test("passes when count equals minProposals", async () => {
		const { proposalCountGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal()];
		const result = await proposalCountGrader.grade(
			output,
			makeReference({ minProposals: 1, maxProposals: 5 }),
		);
		expect(result.pass).toBe(true);
	});

	test("passes when count equals maxProposals", async () => {
		const { proposalCountGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal(), makeProposal(), makeProposal()];
		const result = await proposalCountGrader.grade(
			output,
			makeReference({ minProposals: 1, maxProposals: 3 }),
		);
		expect(result.pass).toBe(true);
	});

	test("fails when too few proposals", async () => {
		const { proposalCountGrader } = await import("../../src/evals/evolution/graders.ts");
		const result = await proposalCountGrader.grade(
			[],
			makeReference({ minProposals: 1, maxProposals: 5 }),
		);
		expect(result.pass).toBe(false);
		expect(result.score).toBe(0);
	});

	test("fails when too many proposals", async () => {
		const { proposalCountGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal(), makeProposal(), makeProposal(), makeProposal()];
		const result = await proposalCountGrader.grade(
			output,
			makeReference({ minProposals: 1, maxProposals: 2 }),
		);
		expect(result.pass).toBe(false);
	});

	test("passes with maxProposals: 0 and empty array", async () => {
		const { proposalCountGrader } = await import("../../src/evals/evolution/graders.ts");
		const result = await proposalCountGrader.grade(
			[],
			makeReference({ minProposals: 0, maxProposals: 0 }),
		);
		expect(result.pass).toBe(true);
	});
});

describe("jsonShapeGrader", () => {
	test("passes for valid proposal with all required fields", async () => {
		const { jsonShapeGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal()];
		const result = await jsonShapeGrader.grade(output, makeReference());
		expect(result.pass).toBe(true);
	});

	test("passes for empty array", async () => {
		const { jsonShapeGrader } = await import("../../src/evals/evolution/graders.ts");
		const result = await jsonShapeGrader.grade([], makeReference());
		expect(result.pass).toBe(true);
	});

	test("passes for new_variant type", async () => {
		const { jsonShapeGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [
			makeProposal({
				type: "new_variant",
				signals: { entry_long: "rsi < 30" },
				universe: ["AAPL"],
			}),
		];
		const result = await jsonShapeGrader.grade(output, makeReference());
		expect(result.pass).toBe(true);
	});

	test("fails when name is missing", async () => {
		const { jsonShapeGrader } = await import("../../src/evals/evolution/graders.ts");
		const bad = makeProposal() as Record<string, unknown>;
		delete bad.name;
		const result = await jsonShapeGrader.grade([bad as MutationProposal], makeReference());
		expect(result.pass).toBe(false);
	});

	test("fails when reasoning is missing", async () => {
		const { jsonShapeGrader } = await import("../../src/evals/evolution/graders.ts");
		const bad = makeProposal() as Record<string, unknown>;
		delete bad.reasoning;
		const result = await jsonShapeGrader.grade([bad as MutationProposal], makeReference());
		expect(result.pass).toBe(false);
	});

	test("fails when parameters is an array", async () => {
		const { jsonShapeGrader } = await import("../../src/evals/evolution/graders.ts");
		const bad = { ...makeProposal(), parameters: [1, 2, 3] as unknown as Record<string, number> };
		const result = await jsonShapeGrader.grade([bad], makeReference());
		expect(result.pass).toBe(false);
	});
});

describe("parameterRangeGrader", () => {
	test("passes when all parameters are within constraints", async () => {
		const { parameterRangeGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parameters: { hold_days: 5, stop_loss_pct: 3 } })];
		const ref = makeReference({
			parameterConstraints: {
				hold_days: { min: 1, max: 20 },
				stop_loss_pct: { min: 1, max: 10 },
			},
		});
		const result = await parameterRangeGrader.grade(output, ref);
		expect(result.pass).toBe(true);
	});

	test("fails when a parameter is below minimum", async () => {
		const { parameterRangeGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parameters: { hold_days: 0 } })];
		const ref = makeReference({
			parameterConstraints: { hold_days: { min: 1, max: 20 } },
		});
		const result = await parameterRangeGrader.grade(output, ref);
		expect(result.pass).toBe(false);
	});

	test("fails when a parameter exceeds maximum", async () => {
		const { parameterRangeGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parameters: { position_size_pct: 30 } })];
		const ref = makeReference({
			parameterConstraints: { position_size_pct: { min: 2, max: 25 } },
		});
		const result = await parameterRangeGrader.grade(output, ref);
		expect(result.pass).toBe(false);
	});

	test("passes when no constraints defined", async () => {
		const { parameterRangeGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parameters: { hold_days: 999 } })];
		const ref = makeReference();
		const result = await parameterRangeGrader.grade(output, ref);
		expect(result.pass).toBe(true);
	});

	test("passes for empty output with constraints", async () => {
		const { parameterRangeGrader } = await import("../../src/evals/evolution/graders.ts");
		const ref = makeReference({
			parameterConstraints: { hold_days: { min: 1, max: 20 } },
		});
		const result = await parameterRangeGrader.grade([], ref);
		expect(result.pass).toBe(true);
	});

	test("passes when proposal uses unconstrained param keys", async () => {
		const { parameterRangeGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parameters: { exit_target_pct: 5 } })];
		const ref = makeReference({
			parameterConstraints: { hold_days: { min: 1, max: 20 } },
		});
		const result = await parameterRangeGrader.grade(output, ref);
		expect(result.pass).toBe(true);
	});
});

describe("parentTargetGrader", () => {
	test("passes when at least one proposal targets expected parent", async () => {
		const { parentTargetGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parentId: 42 }), makeProposal({ parentId: 7 })];
		const ref = makeReference({ expectedParentId: 42 });
		const result = await parentTargetGrader.grade(output, ref);
		expect(result.pass).toBe(true);
	});

	test("fails when no proposal targets expected parent", async () => {
		const { parentTargetGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parentId: 7 }), makeProposal({ parentId: 8 })];
		const ref = makeReference({ expectedParentId: 42 });
		const result = await parentTargetGrader.grade(output, ref);
		expect(result.pass).toBe(false);
	});

	test("passes when no expectedParentId constraint set", async () => {
		const { parentTargetGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parentId: 99 })];
		const ref = makeReference();
		const result = await parentTargetGrader.grade(output, ref);
		expect(result.pass).toBe(true);
	});

	test("fails when expectedParentId set but output is empty", async () => {
		const { parentTargetGrader } = await import("../../src/evals/evolution/graders.ts");
		const ref = makeReference({ expectedParentId: 1 });
		const result = await parentTargetGrader.grade([], ref);
		expect(result.pass).toBe(false);
	});
});

describe("maxParametersGrader", () => {
	test("passes when all proposals have ≤5 parameters", async () => {
		const { maxParametersGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [
			makeProposal({ parameters: { a: 1, b: 2, c: 3, d: 4, e: 5 } }),
			makeProposal({ parameters: { x: 1 } }),
		];
		const result = await maxParametersGrader.grade(output, makeReference());
		expect(result.pass).toBe(true);
	});

	test("passes for empty output", async () => {
		const { maxParametersGrader } = await import("../../src/evals/evolution/graders.ts");
		const result = await maxParametersGrader.grade([], makeReference());
		expect(result.pass).toBe(true);
	});

	test("fails when a proposal has 6 parameters", async () => {
		const { maxParametersGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parameters: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } })];
		const result = await maxParametersGrader.grade(output, makeReference());
		expect(result.pass).toBe(false);
		expect(result.score).toBe(0);
	});

	test("fails when second proposal exceeds limit", async () => {
		const { maxParametersGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [
			makeProposal({ parameters: { a: 1, b: 2 } }),
			makeProposal({ parameters: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } }),
		];
		const result = await maxParametersGrader.grade(output, makeReference());
		expect(result.pass).toBe(false);
	});

	test("passes at exactly 5 parameters", async () => {
		const { maxParametersGrader } = await import("../../src/evals/evolution/graders.ts");
		const output = [makeProposal({ parameters: { a: 1, b: 2, c: 3, d: 4, e: 5 } })];
		const result = await maxParametersGrader.grade(output, makeReference());
		expect(result.pass).toBe(true);
	});
});
