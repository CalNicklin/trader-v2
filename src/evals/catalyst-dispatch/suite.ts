import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config.ts";
import { buildCatalystPrompt } from "../../strategy/catalyst-prompt.ts";
import { type DispatchDecision, parseDispatchResponse } from "../../strategy/dispatch.ts";
import { recordUsage } from "../../utils/token-tracker.ts";
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { allCatalystDispatchGraders } from "./graders.ts";
import {
	type CatalystDispatchInput,
	type CatalystDispatchReference,
	catalystDispatchTasks,
} from "./tasks.ts";

export async function runCatalystDispatchEvals(
	options: { trials?: number; tags?: string[]; saveDir?: string } = {},
): Promise<void> {
	const { trials = 3, tags, saveDir = "src/evals/catalyst-dispatch/results" } = options;

	let tasks = catalystDispatchTasks;
	if (tags && tags.length > 0) {
		tasks = tasks.filter((t) => tags.some((tag) => t.tags.includes(tag)));
	}

	console.log(`Running catalyst-dispatch evals: ${tasks.length} tasks, ${trials} trials each\n`);

	const results = await runSuite<
		CatalystDispatchInput,
		DispatchDecision[],
		CatalystDispatchReference
	>(
		tasks,
		async (input) => {
			const prompt = buildCatalystPrompt(input.symbol, input.strategies, input.news);
			const config = getConfig();
			const client = new Anthropic();
			const response = await client.messages.create({
				model: config.CLAUDE_MODEL_FAST,
				max_tokens: 768,
				system: "You are a catalyst-triggered trading dispatcher. Output valid JSON only.",
				messages: [{ role: "user", content: prompt }],
			});
			const textBlock = response.content.find((b) => b.type === "text");
			const rawText = textBlock?.type === "text" ? textBlock.text : "";
			await recordUsage(
				"catalyst_dispatch_eval",
				response.usage.input_tokens,
				response.usage.output_tokens,
			);
			const validIds = new Set(input.strategies.map((s) => s.id));
			return parseDispatchResponse(rawText, validIds);
		},
		allCatalystDispatchGraders,
		{ trials, suiteName: "catalyst-dispatch" },
	);

	console.log(formatSuiteReport(results));

	await Bun.write(`${saveDir}/catalyst-dispatch-latest.json`, JSON.stringify(results, null, 2));
	console.log(`Results saved to ${saveDir}/catalyst-dispatch-latest.json`);
}
