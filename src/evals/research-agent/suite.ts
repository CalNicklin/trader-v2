// src/evals/research-agent/suite.ts

import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config.ts";
import { buildResearchPrompt, parseResearchResponse } from "../../news/research-agent.ts";
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { allResearchGraders } from "./graders.ts";
import { researchAgentTasks } from "./tasks.ts";

export async function runResearchAgentEvals(
	options: { trials?: number; saveDir?: string } = {},
): Promise<void> {
	const trials = options.trials ?? 3;
	const saveDir = options.saveDir ?? "src/evals/research-agent/results";

	const config = getConfig();
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

	const results = await runSuite(
		researchAgentTasks,
		async (input, reference) => {
			const whitelist = reference.whitelist ?? [];
			const primaryExchange = reference.primaryExchange ?? "NASDAQ";
			const prompt = buildResearchPrompt(input, { whitelist, primaryExchange });
			const response = await client.messages.create({
				model: config.CLAUDE_MODEL,
				max_tokens: 1500,
				messages: [{ role: "user", content: prompt }],
			});
			const text = response.content[0]?.type === "text" ? response.content[0].text : "";
			return parseResearchResponse(text);
		},
		allResearchGraders,
		{ trials, suiteName: "research-agent" },
	);

	console.log(formatSuiteReport(results));
	await Bun.write(`${saveDir}/research-agent-latest.json`, JSON.stringify(results, null, 2));
}
