import type { DispatchDecision } from "../../strategy/dispatch.ts";
import type { Grader } from "../types.ts";
import type { CatalystDispatchReference } from "./tasks.ts";

type CG = Grader<DispatchDecision[], CatalystDispatchReference>;

export const jsonShapeGrader: CG = {
	name: "json-shape",
	type: "code",
	grade: async (output) => {
		if (!Array.isArray(output)) {
			return { score: 0, pass: false, reason: "Output is not an array" };
		}
		const allValid = output.every(
			(d) =>
				typeof d.strategyId === "number" &&
				typeof d.symbol === "string" &&
				(d.action === "activate" || d.action === "skip") &&
				typeof d.reasoning === "string",
		);
		return {
			score: allValid ? 1 : 0,
			pass: allValid,
			reason: allValid
				? `${output.length} decisions, all valid shape`
				: "At least one decision has invalid shape",
		};
	},
};

export const actionCorrectnessGrader: CG = {
	name: "action-correctness",
	type: "code",
	grade: async (output, reference) => {
		const activated = new Set(
			output.filter((d) => d.action === "activate").map((d) => d.strategyId),
		);
		const skipped = new Set(output.filter((d) => d.action === "skip").map((d) => d.strategyId));

		const expectedActivated = new Set(reference.expectActivated);
		const expectedSkipped = new Set(reference.expectSkipped);

		const activateMatches = [...expectedActivated].filter((id) => activated.has(id)).length;
		const skipMatches = [...expectedSkipped].filter((id) => skipped.has(id)).length;

		const totalExpected = expectedActivated.size + expectedSkipped.size;
		const totalMatches = activateMatches + skipMatches;
		const score = totalExpected === 0 ? 1 : totalMatches / totalExpected;

		return {
			score,
			pass: score >= 0.5,
			reason:
				`activate ${activateMatches}/${expectedActivated.size}, ` +
				`skip ${skipMatches}/${expectedSkipped.size}`,
		};
	},
};

export const allCatalystDispatchGraders: CG[] = [jsonShapeGrader, actionCorrectnessGrader];
