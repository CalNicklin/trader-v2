import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config.ts";
import { buildEvolutionPrompt, parseEvolutionResponse } from "../../evolution/prompt.ts";
import type { MutationProposal } from "../../evolution/types.ts";
import { runSuite, type SuiteOptions } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { ALL_GRADERS } from "./graders.ts";
import type { EvolutionInput, EvolutionReference } from "./tasks.ts";
import { EVOLUTION_TASKS } from "./tasks.ts";

export async function runEvolutionEvalSuite(options?: Partial<SuiteOptions>): Promise<void> {
	const { trials = 2, suiteName = "evolution" } = options ?? {};

	const client = new Anthropic();
	const config = getConfig();

	const tasks = EVOLUTION_TASKS;

	console.log(`Running evolution evals: ${tasks.length} tasks, ${trials} trials each\n`);

	const results = await runSuite<EvolutionInput, MutationProposal[], EvolutionReference>(
		tasks,
		async (input) => {
			const { system, user } = buildEvolutionPrompt(input.landscape);

			const response = await client.messages.create({
				model: config.CLAUDE_MODEL,
				max_tokens: 4096,
				system,
				messages: [{ role: "user", content: user }],
			});

			const textBlock = response.content.find((b) => b.type === "text");
			const rawText = textBlock?.type === "text" ? textBlock.text : "";

			return parseEvolutionResponse(rawText);
		},
		ALL_GRADERS,
		{ trials, suiteName },
	);

	console.log(formatSuiteReport(results));
}
