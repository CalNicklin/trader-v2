import Anthropic from "@anthropic-ai/sdk";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { resetConfigForTesting } from "../../config.ts";
import { closeDb, getDb } from "../../db/client.ts";
import { getActivePrompt } from "../../learning/prompts.ts";
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { adjustmentPresenceGrader, hasPatternTagsGrader, validJsonGrader } from "./graders.ts";
import { tradeReviewTasks } from "./tasks.ts";

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
	const trials = options.trials ?? 3;

	// Use a fresh in-memory DB with all migrations applied
	const origDbPath = process.env.DB_PATH;
	process.env.DB_PATH = ":memory:";
	resetConfigForTesting();
	closeDb();
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });

	const { promptText } = await getActivePrompt("trade_review");
	const client = new Anthropic();

	const results = await runSuite<{ tradePrompt: string }, TradeReviewOutput, TradeReviewReference>(
		tradeReviewTasks,
		async (input) => {
			const response = await client.messages.create({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 500,
				system: promptText,
				messages: [{ role: "user", content: input.tradePrompt }],
			});
			const text = response.content[0]?.type === "text" ? response.content[0].text : "";
			return { rawResponse: text };
		},
		[validJsonGrader, hasPatternTagsGrader, adjustmentPresenceGrader],
		{ trials, suiteName: options.suiteName ?? "learning" },
	);

	console.log(formatSuiteReport(results));

	// Restore original DB
	closeDb();
	if (origDbPath) process.env.DB_PATH = origDbPath;
	else delete process.env.DB_PATH;
	resetConfigForTesting();
}
