import { describe, expect, test } from "bun:test";
import { gradeDispatch } from "../../src/evals/dispatch/graders.ts";
import { DISPATCH_EVAL_TASKS } from "../../src/evals/dispatch/tasks.ts";

describe("dispatch eval infrastructure", () => {
	test("has at least 3 eval tasks defined", () => {
		expect(DISPATCH_EVAL_TASKS.length).toBeGreaterThanOrEqual(3);
	});

	test("grader scores perfect dispatch as pass", () => {
		const task = DISPATCH_EVAL_TASKS[0]!;
		const perfectDecisions = task.expectedActivations.map((e) => ({
			strategyId: e.strategyId,
			symbol: e.symbol,
			action: "activate" as const,
			reasoning: "test",
		}));
		const result = gradeDispatch(task, perfectDecisions);
		expect(result.f1).toBe(1);
		expect(result.pass).toBe(true);
	});

	test("grader scores empty dispatch as fail", () => {
		const task = DISPATCH_EVAL_TASKS[0]!;
		const result = gradeDispatch(task, []);
		expect(result.f1).toBe(0);
		expect(result.pass).toBe(false);
	});
});
