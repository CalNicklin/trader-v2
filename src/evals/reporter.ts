import type { SuiteResults } from "./types.ts";

export function formatSuiteReport<T>(results: SuiteResults<T>): string {
	const lines: string[] = [];
	lines.push(`\n=== ${results.suiteName} ===`);
	lines.push(
		`Tasks: ${results.summary.totalTasks} | Pass rate: ${(results.summary.passRate * 100).toFixed(1)}% | Avg score: ${results.summary.avgScore.toFixed(3)} | Duration: ${results.summary.totalDurationMs}ms`,
	);
	lines.push("");

	for (const task of results.tasks) {
		const status = task.passRate >= 0.5 ? "PASS" : "FAIL";
		const trial = task.trials[0];
		lines.push(
			`  [${status}] ${task.taskId} (pass@${task.trials.length}: ${(task.passRate * 100).toFixed(0)}%)`,
		);

		if (trial) {
			for (const grade of trial.grades) {
				const icon = grade.pass ? "  ✓" : "  ✗";
				lines.push(`    ${icon} ${grade.graderName}: ${grade.reason}`);
			}
			if (trial.error) {
				lines.push(`    ERROR: ${trial.error}`);
			}
		}
	}

	lines.push("");
	return lines.join("\n");
}

export async function saveResults<T>(results: SuiteResults<T>, dir: string): Promise<string> {
	const filename = `${results.suiteName.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.json`;
	const path = `${dir}/${filename}`;
	await Bun.write(path, JSON.stringify(results, null, 2));
	return path;
}
