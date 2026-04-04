import type { Grader } from "../types.ts";
import type { PreFilterReference } from "./tasks.ts";

export const correctnessGrader: Grader<boolean, PreFilterReference> = {
	name: "correctness",
	type: "code",
	grade: async (output, reference) => {
		const match = output === reference.shouldPass;
		return {
			score: match ? 1 : 0,
			pass: match,
			reason: match
				? `Correctly ${output ? "passed" : "blocked"}: ${reference.reason}`
				: `Expected ${reference.shouldPass ? "pass" : "block"}, got ${output ? "pass" : "block"}: ${reference.reason}`,
		};
	},
};

export const allPreFilterGraders: Grader<boolean, PreFilterReference>[] = [correctnessGrader];
