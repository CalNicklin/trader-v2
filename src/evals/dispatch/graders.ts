import type { DispatchDecision } from "../../strategy/dispatch.ts";
import type { DispatchEvalTask } from "./tasks.ts";

export interface GradeResult {
	taskId: string;
	precision: number;
	recall: number;
	f1: number;
	pass: boolean;
	details: string;
}

export function gradeDispatch(task: DispatchEvalTask, decisions: DispatchDecision[]): GradeResult {
	const activated = decisions.filter((d) => d.action === "activate");
	const expectedSet = new Set(task.expectedActivations.map((e) => `${e.strategyId}:${e.symbol}`));
	const activatedSet = new Set(activated.map((d) => `${d.strategyId}:${d.symbol}`));

	const truePositives = [...activatedSet].filter((k) => expectedSet.has(k)).length;
	const precision = activated.length > 0 ? truePositives / activated.length : 0;
	const recall = expectedSet.size > 0 ? truePositives / expectedSet.size : 0;
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

	return {
		taskId: task.id,
		precision,
		recall,
		f1,
		pass: f1 >= 0.5,
		details: `TP=${truePositives}, Activated=${activated.length}, Expected=${expectedSet.size}`,
	};
}
