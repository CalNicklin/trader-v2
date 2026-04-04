import { describe, expect, test } from "bun:test";

describe("pipeline graders", () => {
	test("outcomeGrader passes when pipeline result matches expected", async () => {
		const { outcomeGrader } = await import("../../src/evals/pipeline/graders.ts");

		const pass = await outcomeGrader.grade(
			{ pipelineResult: "classified", sentiment: 0.8, tradeable: true },
			{
				expectedOutcome: "classified",
				expectedTradeable: true,
				sentimentMin: 0.5,
				sentimentMax: 1.0,
			},
		);
		expect(pass.pass).toBe(true);
	});

	test("outcomeGrader fails when pipeline result mismatches", async () => {
		const { outcomeGrader } = await import("../../src/evals/pipeline/graders.ts");

		const fail = await outcomeGrader.grade(
			{ pipelineResult: "filtered", sentiment: null, tradeable: null },
			{
				expectedOutcome: "classified",
				expectedTradeable: true,
				sentimentMin: 0.5,
				sentimentMax: 1.0,
			},
		);
		expect(fail.pass).toBe(false);
	});

	test("sentimentWrittenGrader passes when sentiment in range", async () => {
		const { sentimentWrittenGrader } = await import("../../src/evals/pipeline/graders.ts");

		const pass = await sentimentWrittenGrader.grade(
			{ pipelineResult: "classified", sentiment: 0.7, tradeable: true },
			{
				expectedOutcome: "classified",
				expectedTradeable: true,
				sentimentMin: 0.5,
				sentimentMax: 1.0,
			},
		);
		expect(pass.pass).toBe(true);
	});
});
