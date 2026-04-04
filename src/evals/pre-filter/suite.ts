import { shouldClassify } from "../../news/pre-filter.ts";
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { allPreFilterGraders } from "./graders.ts";
import { type PreFilterReference, preFilterTasks } from "./tasks.ts";

export async function runPreFilterEvals(
	options: { tags?: string[]; saveDir?: string } = {},
): Promise<void> {
	const { tags, saveDir = "src/evals/results" } = options;

	let tasks = preFilterTasks;
	if (tags && tags.length > 0) {
		tasks = tasks.filter((t) => tags.some((tag) => t.tags.includes(tag)));
	}

	console.log(`Running pre-filter evals: ${tasks.length} tasks\n`);

	const results = await runSuite<string, boolean, PreFilterReference>(
		tasks,
		async (headline) => shouldClassify(headline),
		allPreFilterGraders,
		{ trials: 1, suiteName: "pre-filter" }, // Deterministic — 1 trial sufficient
	);

	console.log(formatSuiteReport(results));

	await Bun.write(`${saveDir}/pre-filter-latest.json`, JSON.stringify(results, null, 2));
	console.log(`Results saved to ${saveDir}/pre-filter-latest.json`);
}
