import type { ClassificationResult } from "../../news/classifier.ts";
import { classifyHeadline } from "../../news/classifier.ts";
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { allClassifierGraders } from "./graders.ts";
import type { ClassifierReference } from "./tasks.ts";
import { type ClassifierInput, classifierTasks } from "./tasks.ts";

export async function runClassifierEvals(
	options: { trials?: number; tags?: string[]; saveDir?: string } = {},
): Promise<void> {
	const { trials = 3, tags, saveDir = "src/evals/results" } = options;

	let tasks = classifierTasks;
	if (tags && tags.length > 0) {
		tasks = tasks.filter((t) => tags.some((tag) => t.tags.includes(tag)));
	}

	console.log(`Running classifier evals: ${tasks.length} tasks, ${trials} trials each\n`);

	const results = await runSuite<ClassifierInput, ClassificationResult, ClassifierReference>(
		tasks,
		async (input) => {
			const result = await classifyHeadline(input.headline, input.symbol);
			if (!result) throw new Error("Classification returned null");
			return result;
		},
		allClassifierGraders,
		{ trials },
	);

	results.suiteName = "classifier";

	console.log(formatSuiteReport(results));

	await Bun.write(`${saveDir}/classifier-latest.json`, JSON.stringify(results, null, 2));
	console.log(`Results saved to ${saveDir}/classifier-latest.json`);
}
