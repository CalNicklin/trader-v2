import type { Grader } from "../types.ts";
import type { PipelineOutput, PipelineReference } from "./tasks.ts";

export const outcomeGrader: Grader<PipelineOutput, PipelineReference> = {
	name: "outcome",
	type: "code",
	grade: async (output, reference) => {
		const match = output.pipelineResult === reference.expectedOutcome;
		return {
			score: match ? 1 : 0,
			pass: match,
			reason: match
				? `Pipeline returned "${output.pipelineResult}" as expected`
				: `Expected "${reference.expectedOutcome}", got "${output.pipelineResult}"`,
		};
	},
};

export const tradeableGrader: Grader<PipelineOutput, PipelineReference> = {
	name: "tradeable",
	type: "code",
	grade: async (output, reference) => {
		if (reference.expectedTradeable === null) {
			return { score: 1, pass: true, reason: "No tradeable expectation (filtered)" };
		}
		const match = output.tradeable === reference.expectedTradeable;
		return {
			score: match ? 1 : 0,
			pass: match,
			reason: match
				? `Tradeable=${output.tradeable} as expected`
				: `Expected tradeable=${reference.expectedTradeable}, got ${output.tradeable}`,
		};
	},
};

export const sentimentWrittenGrader: Grader<PipelineOutput, PipelineReference> = {
	name: "sentiment-written",
	type: "code",
	grade: async (output, reference) => {
		if (reference.expectedOutcome === "filtered") {
			const pass = output.sentiment === null;
			return {
				score: pass ? 1 : 0,
				pass,
				reason: pass
					? "No sentiment for filtered article"
					: "Filtered article should not have sentiment",
			};
		}
		if (output.sentiment === null) {
			return { score: 0, pass: false, reason: "Expected sentiment but got null" };
		}
		const inRange =
			output.sentiment >= reference.sentimentMin && output.sentiment <= reference.sentimentMax;
		return {
			score: inRange ? 1 : 0,
			pass: inRange,
			reason: inRange
				? `Sentiment ${output.sentiment.toFixed(2)} in expected range`
				: `Sentiment ${output.sentiment.toFixed(2)} outside [${reference.sentimentMin}, ${reference.sentimentMax}]`,
		};
	},
};

export const allPipelineGraders: Grader<PipelineOutput, PipelineReference>[] = [
	outcomeGrader,
	tradeableGrader,
	sentimentWrittenGrader,
];
