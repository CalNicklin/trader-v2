import { classifyHeadline } from "../../news/classifier.ts";
import type { NewsArticle } from "../../news/finnhub.ts";
import { processArticle } from "../../news/ingest.ts";
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { allPipelineGraders } from "./graders.ts";
import {
	type PipelineInput,
	type PipelineOutput,
	type PipelineReference,
	pipelineTasks,
} from "./tasks.ts";

export async function runPipelineEvals(
	options: { trials?: number; tags?: string[]; saveDir?: string } = {},
): Promise<void> {
	const { trials = 3, tags, saveDir = "src/evals/results" } = options;

	let tasks = pipelineTasks;
	if (tags && tags.length > 0) {
		tasks = tasks.filter((t) => tags.some((tag) => t.tags.includes(tag)));
	}

	console.log(`Running pipeline evals: ${tasks.length} tasks, ${trials} trials each\n`);

	const results = await runSuite<PipelineInput, PipelineOutput, PipelineReference>(
		tasks,
		async (input) => {
			const article: NewsArticle = {
				headline: input.headline,
				symbols: [input.symbol],
				url: null,
				source: "eval",
				publishedAt: new Date(),
				finnhubId: null,
			};

			const result = await processArticle(article, input.exchange, classifyHeadline);

			// Read back what was stored
			const { getDb } = await import("../../db/client.ts");
			const { newsEvents } = await import("../../db/schema.ts");
			const { eq, desc } = await import("drizzle-orm");
			const db = getDb();

			const [event] = await db
				.select()
				.from(newsEvents)
				.where(eq(newsEvents.headline, input.headline))
				.orderBy(desc(newsEvents.id))
				.limit(1);

			return {
				pipelineResult: result,
				sentiment: event?.sentiment ?? null,
				tradeable: event?.tradeable ?? null,
			};
		},
		allPipelineGraders,
		{ trials },
	);

	results.suiteName = "pipeline";

	console.log(formatSuiteReport(results));

	await Bun.write(`${saveDir}/pipeline-latest.json`, JSON.stringify(results, null, 2));
	console.log(`Results saved to ${saveDir}/pipeline-latest.json`);
}
