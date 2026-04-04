import type { MutationProposal } from "../../evolution/types.ts";
import type { Grader } from "../types.ts";
import type { EvolutionReference } from "./tasks.ts";

type EG = Grader<MutationProposal[], EvolutionReference>;

export const proposalCountGrader: EG = {
	name: "proposal-count",
	type: "code",
	grade: async (output, reference) => {
		const count = output.length;
		const { minProposals, maxProposals } = reference;
		const pass = count >= minProposals && count <= maxProposals;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass
				? `Proposal count ${count} is within [${minProposals}, ${maxProposals}]`
				: `Proposal count ${count} is outside [${minProposals}, ${maxProposals}]`,
		};
	},
};

export const jsonShapeGrader: EG = {
	name: "json-shape",
	type: "code",
	grade: async (output) => {
		if (output.length === 0) {
			return { score: 1, pass: true, reason: "Empty array is valid shape" };
		}

		const requiredFields: (keyof MutationProposal)[] = [
			"parentId",
			"type",
			"name",
			"description",
			"parameters",
			"reasoning",
		];

		const validTypes = ["parameter_tweak", "new_variant"];
		const failures: string[] = [];

		for (const [i, proposal] of output.entries()) {
			for (const field of requiredFields) {
				if (proposal[field] === undefined || proposal[field] === null) {
					failures.push(`Proposal[${i}] missing field: ${field}`);
				}
			}

			if (!validTypes.includes(proposal.type)) {
				failures.push(`Proposal[${i}] invalid type: ${proposal.type}`);
			}

			if (
				typeof proposal.parameters !== "object" ||
				proposal.parameters === null ||
				Array.isArray(proposal.parameters)
			) {
				failures.push(`Proposal[${i}] parameters must be a plain object`);
			}
		}

		const pass = failures.length === 0;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass ? "All proposals have valid shape" : failures.join("; "),
		};
	},
};

export const parameterRangeGrader: EG = {
	name: "parameter-range",
	type: "code",
	grade: async (output, reference) => {
		if (!reference.parameterConstraints) {
			return { score: 1, pass: true, reason: "No parameter constraints defined — pass" };
		}

		if (output.length === 0) {
			return { score: 1, pass: true, reason: "No proposals to check" };
		}

		const constraints = reference.parameterConstraints;
		const violations: string[] = [];

		for (const [i, proposal] of output.entries()) {
			for (const [key, value] of Object.entries(proposal.parameters)) {
				const constraint = constraints[key];
				if (!constraint) continue;
				if (typeof value !== "number") {
					violations.push(`Proposal[${i}].parameters.${key} is not a number`);
					continue;
				}
				if (value < constraint.min || value > constraint.max) {
					violations.push(
						`Proposal[${i}].parameters.${key}=${value} outside [${constraint.min}, ${constraint.max}]`,
					);
				}
			}
		}

		const pass = violations.length === 0;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass ? "All parameters within allowed ranges" : violations.join("; "),
		};
	},
};

export const parentTargetGrader: EG = {
	name: "parent-target",
	type: "code",
	grade: async (output, reference) => {
		if (reference.expectedParentId === undefined) {
			return { score: 1, pass: true, reason: "No parent target constraint — pass" };
		}

		if (output.length === 0) {
			return {
				score: 0,
				pass: false,
				reason: `Expected at least one proposal targeting parentId=${reference.expectedParentId}, got empty array`,
			};
		}

		const targeted = output.some((p) => p.parentId === reference.expectedParentId);
		return {
			score: targeted ? 1 : 0,
			pass: targeted,
			reason: targeted
				? `At least one proposal targets parentId=${reference.expectedParentId}`
				: `No proposal targets parentId=${reference.expectedParentId}`,
		};
	},
};

export const maxParametersGrader: EG = {
	name: "max-parameters",
	type: "code",
	grade: async (output) => {
		if (output.length === 0) {
			return { score: 1, pass: true, reason: "No proposals to check" };
		}

		const MAX_PARAMS = 5;
		const violations: string[] = [];

		for (const [i, proposal] of output.entries()) {
			const paramCount = Object.keys(proposal.parameters).length;
			if (paramCount > MAX_PARAMS) {
				violations.push(
					`Proposal[${i}] "${proposal.name}" has ${paramCount} parameters (max ${MAX_PARAMS})`,
				);
			}
		}

		const pass = violations.length === 0;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass ? `All proposals have ≤${MAX_PARAMS} parameters` : violations.join("; "),
		};
	},
};

export const ALL_GRADERS: EG[] = [
	proposalCountGrader,
	jsonShapeGrader,
	parameterRangeGrader,
	parentTargetGrader,
	maxParametersGrader,
];
