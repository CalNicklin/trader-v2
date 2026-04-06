import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config.ts";
import type { StrategyPerformance } from "../../evolution/types.ts";
import { parseDispatchResponse } from "../../strategy/dispatch.ts";
import { buildDispatchPrompt } from "../../strategy/dispatch-prompt.ts";
import { createChildLogger } from "../../utils/logger.ts";
import { recordUsage } from "../../utils/token-tracker.ts";
import { type GradeResult, gradeDispatch } from "./graders.ts";
import { DISPATCH_EVAL_TASKS } from "./tasks.ts";

const log = createChildLogger({ module: "eval:dispatch" });

export async function runDispatchEvals(trials = 3): Promise<{
	results: GradeResult[];
	passRate: number;
	avgF1: number;
}> {
	const allResults: GradeResult[] = [];

	for (const task of DISPATCH_EVAL_TASKS) {
		for (let trial = 0; trial < trials; trial++) {
			const fakeStrategies: StrategyPerformance[] = task.strategies.map((s) => ({
				id: s.id,
				name: s.name,
				status: "probation" as const,
				generation: 1,
				parentStrategyId: null,
				createdBy: "seed" as const,
				parameters: {},
				signals: { entry_long: "last > 0" },
				universe: task.symbols,
				metrics: {
					sampleSize: 30,
					winRate: 0.55,
					expectancy: 0.1,
					profitFactor: 1.5,
					sharpeRatio: s.sharpe,
					sortinoRatio: s.sharpe * 1.2,
					maxDrawdownPct: 8,
					calmarRatio: 1.0,
					consistencyScore: 3,
				},
				recentTrades: [],
				virtualBalance: 10000,
				insightSummary: [],
			}));

			const prompt = buildDispatchPrompt(fakeStrategies, task.regime, task.recentNews);

			const config = getConfig();
			const client = new Anthropic();
			const apiResponse = await client.messages.create({
				model: config.CLAUDE_MODEL_FAST,
				max_tokens: 1024,
				system: "You are a trading strategy dispatcher. Output valid JSON only.",
				messages: [{ role: "user", content: prompt }],
			});

			const textBlock = apiResponse.content.find((b) => b.type === "text");
			const rawText = textBlock?.type === "text" ? textBlock.text : "";

			await recordUsage(
				"dispatch_eval",
				apiResponse.usage.input_tokens,
				apiResponse.usage.output_tokens,
			);

			const decisions = parseDispatchResponse(rawText, new Set(task.strategies.map((s) => s.id)));
			const result = gradeDispatch(task, decisions);
			allResults.push(result);

			log.info(
				{
					taskId: task.id,
					trial: trial + 1,
					f1: result.f1,
					pass: result.pass,
				},
				"Dispatch eval trial complete",
			);
		}
	}

	const passRate = allResults.filter((r) => r.pass).length / allResults.length;
	const avgF1 = allResults.reduce((sum, r) => sum + r.f1, 0) / allResults.length;

	return { results: allResults, passRate, avgF1 };
}
