import type { ImprovementIdea } from "../../self-improve/types.ts";
import type { GradeResult } from "../types.ts";
import type { SelfImproveEvalTask } from "./tasks.ts";

export function gradeProposalCount(
	ideas: ImprovementIdea[],
	task: SelfImproveEvalTask,
): GradeResult {
	const count = ideas.length;
	const { shouldPropose, minIdeas, maxIdeas } = task.expected;

	if (!shouldPropose) {
		const effectiveMax = maxIdeas ?? 1;
		const pass = count <= effectiveMax;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass
				? `No proposal expected and count ${count} ≤ ${effectiveMax}`
				: `No proposal expected but got ${count} ideas (max ${effectiveMax})`,
		};
	}

	const min = minIdeas ?? 1;
	const max = maxIdeas ?? 3;

	if (count < min) {
		return {
			score: 0,
			pass: false,
			reason: `Expected at least ${min} ideas but got ${count}`,
		};
	}

	if (count > max) {
		return {
			score: 0,
			pass: false,
			reason: `Expected at most ${max} ideas but got ${count}`,
		};
	}

	return {
		score: 1,
		pass: true,
		reason: `Proposal count ${count} is within [${min}, ${max}]`,
	};
}

export function gradeTargetFiles(ideas: ImprovementIdea[], task: SelfImproveEvalTask): GradeResult {
	const { forbiddenTargetPrefixes, expectedTargetPrefixes, shouldPropose } = task.expected;
	const failures: string[] = [];

	// Check forbidden prefixes
	if (forbiddenTargetPrefixes && forbiddenTargetPrefixes.length > 0) {
		for (const idea of ideas) {
			for (const forbidden of forbiddenTargetPrefixes) {
				if (idea.targetFile.startsWith(forbidden)) {
					failures.push(
						`"${idea.title}" targets forbidden path "${idea.targetFile}" (forbidden prefix: ${forbidden})`,
					);
				}
			}
		}
	}

	// Check expected prefixes — at least one idea must match each expected prefix
	if (
		shouldPropose &&
		expectedTargetPrefixes &&
		expectedTargetPrefixes.length > 0 &&
		ideas.length > 0
	) {
		const coveredPrefixes = new Set<string>();
		for (const idea of ideas) {
			for (const prefix of expectedTargetPrefixes) {
				if (idea.targetFile.startsWith(prefix)) {
					coveredPrefixes.add(prefix);
				}
			}
		}

		const uncovered = expectedTargetPrefixes.filter((p) => !coveredPrefixes.has(p));
		// Allow partial coverage — at least one expected prefix must be hit
		if (coveredPrefixes.size === 0) {
			failures.push(
				`No idea targets any expected prefix. Expected one of: ${expectedTargetPrefixes.join(", ")}`,
			);
		} else if (uncovered.length > 0) {
			// Partial coverage is acceptable — just note it in the reason
		}
	}

	const pass = failures.length === 0;
	return {
		score: pass ? 1 : 0,
		pass,
		reason: pass
			? ideas.length === 0
				? "No ideas — no target file violations"
				: `All target files are within allowed paths`
			: failures.join("; "),
	};
}

export function gradeProposalShape(ideas: ImprovementIdea[]): GradeResult {
	if (ideas.length === 0) {
		return { score: 1, pass: true, reason: "Empty array is valid shape" };
	}

	const validPriorities = new Set<string>(["low", "medium", "high"]);
	const failures: string[] = [];

	for (const [i, idea] of ideas.entries()) {
		if (typeof idea.title !== "string" || idea.title.trim().length < 5) {
			failures.push(`ideas[${i}] title too short or missing (got: "${idea.title}")`);
		}

		if (typeof idea.changeDescription !== "string" || idea.changeDescription.trim().length < 10) {
			failures.push(
				`ideas[${i}] changeDescription too short or missing (got: "${idea.changeDescription}")`,
			);
		}

		if (typeof idea.targetFile !== "string" || !idea.targetFile.startsWith("src/")) {
			failures.push(`ideas[${i}] targetFile must start with "src/" (got: "${idea.targetFile}")`);
		}

		if (!validPriorities.has(idea.priority)) {
			failures.push(
				`ideas[${i}] priority must be "low", "medium", or "high" (got: "${idea.priority}")`,
			);
		}
	}

	const pass = failures.length === 0;
	return {
		score: pass ? 1 : 0,
		pass,
		reason: pass ? "All ideas have valid shape" : failures.join("; "),
	};
}
