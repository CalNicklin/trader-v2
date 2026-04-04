import type { ClassificationResult } from "../../news/classifier.ts";
import type { Grader } from "../types.ts";
import type { ClassifierReference } from "./tasks.ts";

type CG = Grader<ClassificationResult, ClassifierReference>;

export const jsonShapeGrader: CG = {
	name: "json-shape",
	type: "code",
	grade: async (output) => {
		const hasAll =
			typeof output.tradeable === "boolean" &&
			typeof output.sentiment === "number" &&
			typeof output.confidence === "number" &&
			typeof output.eventType === "string" &&
			typeof output.urgency === "string" &&
			output.sentiment >= -1 &&
			output.sentiment <= 1 &&
			output.confidence >= 0 &&
			output.confidence <= 1;

		return {
			score: hasAll ? 1 : 0,
			pass: hasAll,
			reason: hasAll ? "Valid shape" : "Missing or invalid fields",
		};
	},
};

export const tradeableGrader: CG = {
	name: "tradeable",
	type: "code",
	grade: async (output, reference) => {
		const match = output.tradeable === reference.tradeable;
		return {
			score: match ? 1 : 0,
			pass: match,
			reason: match
				? `Correctly identified as ${output.tradeable ? "" : "non-"}tradeable`
				: `Expected tradeable=${reference.tradeable}, got ${output.tradeable}`,
		};
	},
};

export const sentimentRangeGrader: CG = {
	name: "sentiment-range",
	type: "code",
	grade: async (output, reference) => {
		const inRange =
			output.sentiment >= reference.sentimentMin && output.sentiment <= reference.sentimentMax;

		// Partial credit: how close to the range
		let score = 0;
		if (inRange) {
			score = 1;
		} else {
			const rangeCenter = (reference.sentimentMin + reference.sentimentMax) / 2;
			const distance = Math.abs(output.sentiment - rangeCenter);
			score = Math.max(0, 1 - distance);
		}

		return {
			score,
			pass: inRange,
			reason: inRange
				? `Sentiment ${output.sentiment.toFixed(2)} in range [${reference.sentimentMin}, ${reference.sentimentMax}]`
				: `Sentiment ${output.sentiment.toFixed(2)} outside range [${reference.sentimentMin}, ${reference.sentimentMax}]`,
		};
	},
};

export const eventTypeGrader: CG = {
	name: "event-type",
	type: "code",
	grade: async (output, reference) => {
		const match = reference.expectedEventTypes.includes(output.eventType);
		return {
			score: match ? 1 : 0,
			pass: match,
			reason: match
				? `Event type "${output.eventType}" matches expected`
				: `Event type "${output.eventType}" not in [${reference.expectedEventTypes.join(", ")}]`,
		};
	},
};

export const urgencyGrader: CG = {
	name: "urgency",
	type: "code",
	grade: async (output, reference) => {
		const match = output.urgency === reference.expectedUrgency;
		// Partial credit for adjacent urgency levels
		const levels = ["low", "medium", "high"];
		const outIdx = levels.indexOf(output.urgency);
		const refIdx = levels.indexOf(reference.expectedUrgency);
		const distance = Math.abs(outIdx - refIdx);
		const score = match ? 1 : distance === 1 ? 0.5 : 0;

		return {
			score,
			pass: match,
			reason: match
				? `Urgency "${output.urgency}" matches`
				: `Urgency "${output.urgency}", expected "${reference.expectedUrgency}"`,
		};
	},
};

export const allClassifierGraders: CG[] = [
	jsonShapeGrader,
	tradeableGrader,
	sentimentRangeGrader,
	eventTypeGrader,
	urgencyGrader,
];
