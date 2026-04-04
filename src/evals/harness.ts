import type { EvalTask, Grader, SuiteResults, TrialResult } from "./types.ts";

export async function runTrial<TInput, TOutput, TReference>(
	task: EvalTask<TInput, TReference>,
	fn: (input: TInput) => Promise<TOutput>,
	graders: Grader<TOutput, TReference>[],
): Promise<TrialResult<TOutput>> {
	const start = performance.now();
	let output: TOutput | null = null;
	let error: string | null = null;

	try {
		output = await fn(task.input);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	const grades: TrialResult<TOutput>["grades"] = [];

	if (output !== null) {
		for (const grader of graders) {
			try {
				const result = await grader.grade(output, task.reference);
				grades.push({
					graderName: grader.name,
					score: result.score,
					pass: result.pass,
					reason: result.reason,
				});
			} catch (e) {
				grades.push({
					graderName: grader.name,
					score: 0,
					pass: false,
					reason: `Grader error: ${e instanceof Error ? e.message : String(e)}`,
				});
			}
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

export interface SuiteOptions {
	trials: number;
	suiteName?: string;
}

export async function runSuite<TInput, TOutput, TReference>(
	tasks: EvalTask<TInput, TReference>[],
	fn: (input: TInput) => Promise<TOutput>,
	graders: Grader<TOutput, TReference>[],
	options: SuiteOptions = { trials: 1 },
): Promise<SuiteResults<TOutput>> {
	const start = Date.now();
	const taskResults: SuiteResults<TOutput>["tasks"] = [];

	for (const task of tasks) {
		const trials: TrialResult<TOutput>[] = [];
		for (let t = 0; t < options.trials; t++) {
			const trial = await runTrial(task, fn, graders);
			trials.push(trial);
		}

		const passes = trials.filter(
			(t) => t.grades.length > 0 && t.grades.every((g) => g.pass),
		).length;

		taskResults.push({
			taskId: task.id,
			trials,
			passRate: trials.length > 0 ? passes / trials.length : 0,
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

	return {
		suiteName: options.suiteName ?? "",
		tasks: taskResults,
		summary: {
			totalTasks: tasks.length,
			passRate: overallPassRate,
			avgScore,
			totalDurationMs: Date.now() - start,
		},
		timestamp: new Date().toISOString(),
	};
}
