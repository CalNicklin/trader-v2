// src/evals/missed-opportunity/graders.ts
import type { Grader } from "../types.ts";
import type { TrackerReference } from "./tasks.ts";

interface TrackerOutput {
	missedSymbols: string[];
	reviewedCount: number;
}

type TG = Grader<TrackerOutput, TrackerReference>;

export const missedAccuracyGrader: TG = {
	name: "missed-accuracy",
	type: "code",
	grade: async (output, reference) => {
		const expected = new Set(reference.expectedMissedSymbols);
		const actual = new Set(output.missedSymbols);
		const correct = [...expected].filter((s) => actual.has(s)).length;
		const total = expected.size;
		const score = total > 0 ? correct / total : 1;
		return {
			score,
			pass: score === 1,
			reason: `Found ${correct}/${total} expected missed symbols`,
		};
	},
};

export const noFalsePositivesGrader: TG = {
	name: "no-false-positives",
	type: "code",
	grade: async (output, reference) => {
		const shouldNot = new Set(reference.expectedNotMissedSymbols);
		const falsePositives = output.missedSymbols.filter((s) => shouldNot.has(s));
		const pass = falsePositives.length === 0;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass ? "No false positives" : `False positives: ${falsePositives.join(", ")}`,
		};
	},
};

export const allTrackerGraders: TG[] = [missedAccuracyGrader, noFalsePositivesGrader];
