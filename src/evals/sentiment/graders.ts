import type { Grader } from "../types.ts";

export interface SentimentEvalOutput {
	sentiment: number;
	confidence: number;
	expectedMoveDuration: string;
}

export interface SentimentEvalReference {
	actualPriceChangePct: number;
	actualDirection: "up" | "down" | "flat";
	actualMoveDurationDays: number;
}

type SG = Grader<SentimentEvalOutput, SentimentEvalReference>;

export const directionAccuracyGrader: SG = {
	name: "direction-accuracy",
	type: "code",
	grade: async (output, reference) => {
		if (reference.actualDirection === "flat") {
			return {
				score: 0.5,
				pass: true,
				reason: "Actual direction was flat — no directional signal to validate",
			};
		}

		const sentimentPositive = output.sentiment > 0;
		const directionUp = reference.actualDirection === "up";
		const match = sentimentPositive === directionUp;

		return {
			score: match ? 1 : 0,
			pass: match,
			reason: match
				? `Sentiment ${output.sentiment.toFixed(2)} correctly predicted ${reference.actualDirection}`
				: `Sentiment ${output.sentiment.toFixed(2)} predicted ${sentimentPositive ? "up" : "down"} but actual was ${reference.actualDirection}`,
		};
	},
};

export const magnitudeCalibrationGrader: SG = {
	name: "magnitude-calibration",
	type: "code",
	grade: async (output, reference) => {
		const absMoveP = Math.abs(reference.actualPriceChangePct);
		const normalizedMove = Math.min(absMoveP / 10, 1);
		const score = 1 - Math.abs(output.confidence - normalizedMove);

		let expectedMinMove: number;
		if (output.confidence >= 0.8) {
			expectedMinMove = 3;
		} else if (output.confidence >= 0.6) {
			expectedMinMove = 1;
		} else {
			expectedMinMove = 0;
		}

		const calibrated = absMoveP >= expectedMinMove;

		return {
			score: Math.max(0, score),
			pass: calibrated,
			reason: calibrated
				? `Confidence ${output.confidence.toFixed(2)} calibrated: move ${absMoveP.toFixed(1)}% >= ${expectedMinMove}% threshold`
				: `Confidence ${output.confidence.toFixed(2)} miscalibrated: move ${absMoveP.toFixed(1)}% < ${expectedMinMove}% threshold`,
		};
	},
};

export const durationAccuracyGrader: SG = {
	name: "duration-accuracy",
	type: "code",
	grade: async (output, reference) => {
		const windowMap: Record<string, [number, number]> = {
			intraday: [0, 1],
			"1-3d": [1, 3],
			"1-2w": [5, 14],
			"1m+": [20, 999],
		};

		const window = windowMap[output.expectedMoveDuration];

		if (!window) {
			return {
				score: 0,
				pass: false,
				reason: `Unknown expectedMoveDuration: "${output.expectedMoveDuration}"`,
			};
		}

		const [min, max] = window;
		const within = reference.actualMoveDurationDays >= min && reference.actualMoveDurationDays <= max;

		return {
			score: within ? 1 : 0,
			pass: within,
			reason: within
				? `Duration ${reference.actualMoveDurationDays}d within "${output.expectedMoveDuration}" window [${min}, ${max}]`
				: `Duration ${reference.actualMoveDurationDays}d outside "${output.expectedMoveDuration}" window [${min}, ${max}]`,
		};
	},
};

export const allSentimentGraders: SG[] = [
	directionAccuracyGrader,
	magnitudeCalibrationGrader,
	durationAccuracyGrader,
];
