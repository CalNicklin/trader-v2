import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import type { SentimentEvalOutput, SentimentEvalReference } from "./graders.ts";
import { allSentimentGraders } from "./graders.ts";
import { sentimentTasks } from "./tasks.ts";

export interface SentimentEvalOptions {
	trials?: number;
	suiteName?: string;
	saveDir?: string;
	tags?: string[];
}

export async function runSentimentEvalSuite(options: SentimentEvalOptions = {}): Promise<void> {
	const { trials = 1, suiteName = "sentiment", saveDir = "src/evals/results", tags } = options;

	let tasks = sentimentTasks;
	if (tags && tags.length > 0) {
		tasks = tasks.filter((t) => tags.some((tag) => t.tags.includes(tag)));
	}

	console.log(`Running sentiment evals: ${tasks.length} tasks, ${trials} trial(s) each\n`);

	const results = await runSuite<SentimentEvalOutput, SentimentEvalOutput, SentimentEvalReference>(
		tasks,
		async (input) => input,
		allSentimentGraders,
		{ trials, suiteName },
	);

	console.log(formatSuiteReport(results));

	await Bun.write(`${saveDir}/sentiment-latest.json`, JSON.stringify(results, null, 2));
	console.log(`Results saved to ${saveDir}/sentiment-latest.json`);
}
