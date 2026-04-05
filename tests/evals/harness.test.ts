import { describe, expect, test } from "bun:test";
import type { EvalTask, Grader } from "../../src/evals/types.ts";

describe("eval harness", () => {
	test("EvalTask and EvalResult types are importable", async () => {
		await import("../../src/evals/types.ts");
		// Types are compile-time only — just verify module loads
		expect(true).toBe(true);
	});

	test("runTrial executes task and collects grades", async () => {
		const { runTrial } = await import("../../src/evals/harness.ts");

		const task: EvalTask<string, string> = {
			id: "test-001",
			name: "simple test",
			input: "hello",
			reference: "world",
			tags: ["smoke"],
		};

		const grader: Grader<string, string> = {
			name: "exact-match",
			type: "code",
			grade: async (output: string, reference: string) => ({
				score: output === reference ? 1 : 0,
				pass: output === reference,
				reason: output === reference ? "Match" : `Got "${output}", expected "${reference}"`,
			}),
		};

		const result = await runTrial(task, async (input) => `${input} world`, [grader]);

		expect(result.taskId).toBe("test-001");
		expect(result.output).toBe("hello world");
		expect(result.grades).toHaveLength(1);
		expect(result.grades[0]!.graderName).toBe("exact-match");
		expect(result.grades[0]!.pass).toBe(false);
		expect(result.durationMs).toBeGreaterThan(0);
	});

	test("runTrial handles task function errors gracefully", async () => {
		const { runTrial } = await import("../../src/evals/harness.ts");

		const task: EvalTask<string, string> = {
			id: "test-err",
			name: "error test",
			input: "hello",
			reference: "world",
			tags: [],
		};

		const result = await runTrial(task, async () => {
			throw new Error("boom");
		}, []);

		expect(result.error).toBe("boom");
		expect(result.output).toBeNull();
	});

	test("runSuite runs multiple trials and aggregates", async () => {
		const { runSuite } = await import("../../src/evals/harness.ts");

		const tasks: EvalTask<number, number>[] = [
			{ id: "add-1", name: "add one", input: 1, reference: 2, tags: [] },
			{ id: "add-2", name: "add two", input: 2, reference: 3, tags: [] },
		];

		const grader: Grader<number, number> = {
			name: "correct",
			type: "code",
			grade: async (output: number, reference: number) => ({
				score: output === reference ? 1 : 0,
				pass: output === reference,
				reason: output === reference ? "Correct" : `Got ${output}, expected ${reference}`,
			}),
		};

		const results = await runSuite(tasks, async (n: number) => n + 1, [grader], { trials: 1 });

		expect(results.tasks).toHaveLength(2);
		expect(results.summary.totalTasks).toBe(2);
		expect(results.summary.passRate).toBe(1.0);
	});
});
