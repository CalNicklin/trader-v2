import { parseTradeReviewResponse } from "../../learning/trade-review.ts";
import type { Grader } from "../types.ts";

interface TradeReviewOutput {
	rawResponse: string;
}

interface TradeReviewReference {
	expectedTags: string[];
	expectedQuality: string;
	shouldSuggestAdjustment: boolean;
}

export const validJsonGrader: Grader<TradeReviewOutput, TradeReviewReference> = {
	name: "valid_json",
	type: "code",
	grade: async (output, _reference) => {
		const result = parseTradeReviewResponse(output.rawResponse, 0);
		return {
			score: result ? 1 : 0,
			pass: result !== null,
			reason: result ? "Valid JSON response" : "Invalid or unparseable JSON",
		};
	},
};

export const hasPatternTagsGrader: Grader<TradeReviewOutput, TradeReviewReference> = {
	name: "has_pattern_tags",
	type: "code",
	grade: async (output, reference) => {
		const result = parseTradeReviewResponse(output.rawResponse, 0);
		if (!result) return { score: 0, pass: false, reason: "Could not parse response" };

		if (reference.expectedTags.length === 0) {
			return { score: 1, pass: true, reason: "No tags expected and none required" };
		}

		const matchedTags = reference.expectedTags.filter((tag) =>
			result.patternTags.some((rt) => rt.includes(tag) || tag.includes(rt)),
		);

		const score = matchedTags.length / reference.expectedTags.length;
		return {
			score,
			pass: score >= 0.5,
			reason: `Matched ${matchedTags.length}/${reference.expectedTags.length} expected tags`,
		};
	},
};

export const adjustmentPresenceGrader: Grader<TradeReviewOutput, TradeReviewReference> = {
	name: "adjustment_presence",
	type: "code",
	grade: async (output, reference) => {
		const result = parseTradeReviewResponse(output.rawResponse, 0);
		if (!result) return { score: 0, pass: false, reason: "Could not parse response" };

		const hasAdj = result.suggestedParameterAdjustment !== null;
		const pass = hasAdj === reference.shouldSuggestAdjustment;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass
				? "Adjustment presence matches expectation"
				: `Expected adjustment=${reference.shouldSuggestAdjustment}, got=${hasAdj}`,
		};
	},
};
