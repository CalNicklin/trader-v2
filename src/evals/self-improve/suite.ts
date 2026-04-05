import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config.ts";
import { parseProposerResponse } from "../../self-improve/proposer.ts";
import { WHITELISTED_PATHS, HUMAN_ONLY_PATHS, type ImprovementIdea } from "../../self-improve/types.ts";
import { formatSuiteReport } from "../reporter.ts";
import { gradeProposalCount, gradeTargetFiles, gradeProposalShape } from "./graders.ts";
import { SELF_IMPROVE_EVAL_TASKS, type SelfImproveEvalTask } from "./tasks.ts";

export interface SelfImproveEvalOptions {
	trials?: number;
	suiteName?: string;
	saveDir?: string;
	tags?: string[];
}

interface TaskResult {
	taskId: string;
	taskName: string;
	trials: TrialResult[];
	passRate: number;
}

interface TrialResult {
	taskId: string;
	taskName: string;
	output: ImprovementIdea[] | null;
	error: string | null;
	grades: Array<{ graderName: string; score: number; pass: boolean; reason: string }>;
	durationMs: number;
}

function buildProposerPrompt(landscapeJson: string): string {
	return `You are analysing a trading agent system to identify code improvements.

## Current System State
${landscapeJson}

## Whitelisted Files (you can propose direct code changes)
${WHITELISTED_PATHS.join("\n")}

## Human-Only Files (propose as issues for human review)
${HUMAN_ONLY_PATHS.join("\n")}

## Instructions
Review the system state and propose 1-3 specific, actionable code improvements. Focus on:
- Strategy evaluation logic that could be more accurate
- Signal computation that could capture more alpha
- News classification prompts that could be more precise
- Reporting templates that could be more informative

For each proposal, return a JSON array:
\`\`\`json
[
  {
    "title": "Short descriptive title",
    "description": "Detailed description of what to change and why",
    "targetFile": "src/path/to/file.ts",
    "changeDescription": "Specific instructions for the code change",
    "reasoning": "Why this improvement matters based on the data",
    "priority": "high" | "medium" | "low"
  }
]
\`\`\`

Rules:
- Only propose changes you are confident will improve the system
- Base proposals on actual performance data, not speculation
- Each proposal must target a specific file
- If the system is performing well, return an empty array []
- Return ONLY the JSON array, no other text`;
}

async function runTrial(
	task: SelfImproveEvalTask,
	client: Anthropic,
	model: string,
): Promise<TrialResult> {
	const start = performance.now();
	let output: ImprovementIdea[] | null = null;
	let error: string | null = null;

	try {
		const response = await client.messages.create({
			model,
			max_tokens: 4096,
			messages: [{ role: "user", content: buildProposerPrompt(task.landscapeJson) }],
		});

		const textBlock = response.content.find((b) => b.type === "text");
		const rawText = textBlock?.type === "text" ? textBlock.text : "";
		output = parseProposerResponse(rawText);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	const grades: TrialResult["grades"] = [];

	if (output !== null) {
		// Grade 1: proposal count
		try {
			const countResult = gradeProposalCount(output, task);
			grades.push({ graderName: "proposal-count", ...countResult });
		} catch (e) {
			grades.push({
				graderName: "proposal-count",
				score: 0,
				pass: false,
				reason: `Grader error: ${e instanceof Error ? e.message : String(e)}`,
			});
		}

		// Grade 2: target files
		try {
			const targetResult = gradeTargetFiles(output, task);
			grades.push({ graderName: "target-files", ...targetResult });
		} catch (e) {
			grades.push({
				graderName: "target-files",
				score: 0,
				pass: false,
				reason: `Grader error: ${e instanceof Error ? e.message : String(e)}`,
			});
		}

		// Grade 3: proposal shape
		try {
			const shapeResult = gradeProposalShape(output);
			grades.push({ graderName: "proposal-shape", ...shapeResult });
		} catch (e) {
			grades.push({
				graderName: "proposal-shape",
				score: 0,
				pass: false,
				reason: `Grader error: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	return {
		taskId: task.id,
		taskName: task.name,
		output,
		error,
		grades,
		durationMs: Math.max(1, Math.round(performance.now() - start)),
	};
}

export async function runSelfImproveEvalSuite(options?: SelfImproveEvalOptions): Promise<void> {
	const { trials = 2, suiteName = "self-improve", tags } = options ?? {};

	const client = new Anthropic();
	const config = getConfig();

	let tasks = SELF_IMPROVE_EVAL_TASKS;
	if (tags && tags.length > 0) {
		// tasks don't have tags in their interface, so we skip filtering
	}

	console.log(`Running self-improve evals: ${tasks.length} tasks, ${trials} trials each\n`);

	const taskResults: TaskResult[] = [];
	const start = Date.now();

	for (const task of tasks) {
		const trialResults: TrialResult[] = [];

		for (let t = 0; t < trials; t++) {
			const trial = await runTrial(task, client, config.CLAUDE_MODEL);
			trialResults.push(trial);
		}

		const passes = trialResults.filter(
			(t) => t.grades.length > 0 && t.grades.every((g) => g.pass),
		).length;

		taskResults.push({
			taskId: task.id,
			taskName: task.name,
			trials: trialResults,
			passRate: trialResults.length > 0 ? passes / trialResults.length : 0,
		});
	}

	const overallPassRate =
		taskResults.length > 0
			? taskResults.filter((t) => t.passRate >= 0.5).length / taskResults.length
			: 0;

	const allScores = taskResults.flatMap((t) =>
		t.trials.flatMap((tr) => tr.grades.map((g) => g.score)),
	);
	const avgScore =
		allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;

	const suiteResults = {
		suiteName,
		tasks: taskResults.map((t) => ({
			taskId: t.taskId,
			trials: t.trials,
			passRate: t.passRate,
		})),
		summary: {
			totalTasks: tasks.length,
			passRate: overallPassRate,
			avgScore,
			totalDurationMs: Date.now() - start,
		},
		timestamp: new Date().toISOString(),
	};

	console.log(formatSuiteReport(suiteResults));
}
