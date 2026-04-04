import Anthropic from "@anthropic-ai/sdk";
import { runSuite } from "../harness.ts";
import { tradeReviewTasks } from "./tasks.ts";
import { validJsonGrader, hasPatternTagsGrader, adjustmentPresenceGrader } from "./graders.ts";
import { getActivePrompt } from "../../learning/prompts.ts";

interface TradeReviewOutput {
	rawResponse: string;
}

interface TradeReviewReference {
	expectedTags: string[];
	expectedQuality: string;
	shouldSuggestAdjustment: boolean;
}

export async function runLearningEvalSuite(options: {
	trials?: number;
	suiteName?: string;
}): Promise<void> {
	const trials = options.trials ?? 2;
	const { promptText } = await getActivePrompt("trade_review");
	const client = new Anthropic();

	const results = await runSuite<
		{ tradePrompt: string },
		TradeReviewOutput,
		TradeReviewReference
	>(
		tradeReviewTasks,
		async (input) => {
			const response = await client.messages.create({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 300,
				system: promptText,
				messages: [{ role: "user", content: input.tradePrompt }],
			});
			const text = response.content[0]?.type === "text" ? response.content[0].text : "";
			return { rawResponse: text };
		},
		[validJsonGrader, hasPatternTagsGrader, adjustmentPresenceGrader],
		{ trials, suiteName: options.suiteName ?? "learning" },
	);

	console.log(`\n=== Learning Eval Suite ===`);
	console.log(`Tasks: ${results.summary.totalTasks}`);
	console.log(`Pass rate: ${(results.summary.passRate * 100).toFixed(0)}%`);
	console.log(`Avg score: ${(results.summary.avgScore * 100).toFixed(0)}%`);
	console.log(`Duration: ${results.summary.totalDurationMs}ms\n`);

	for (const task of results.tasks) {
		const status = task.passRate >= 0.5 ? "PASS" : "FAIL";
		console.log(
			`  [${status}] ${task.taskId} — ${task.trials[0]?.taskName ?? "?"} (${(task.passRate * 100).toFixed(0)}%)`,
		);
	}
}
