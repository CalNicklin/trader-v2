export interface EvalTask<TInput, TReference> {
	id: string;
	name: string;
	input: TInput;
	reference: TReference;
	tags: string[];
}

export interface GradeResult {
	score: number; // 0-1
	pass: boolean;
	reason: string;
}

export interface Grader<TOutput, TReference> {
	name: string;
	type: "code" | "llm";
	grade: (output: TOutput, reference: TReference) => Promise<GradeResult>;
}

export interface TrialResult<TOutput> {
	taskId: string;
	taskName: string;
	output: TOutput | null;
	error: string | null;
	grades: Array<{ graderName: string; score: number; pass: boolean; reason: string }>;
	durationMs: number;
}

export interface SuiteResults<TOutput> {
	suiteName: string;
	tasks: Array<{
		taskId: string;
		trials: TrialResult<TOutput>[];
		passRate: number;
	}>;
	summary: {
		totalTasks: number;
		passRate: number;
		avgScore: number;
		totalDurationMs: number;
	};
	timestamp: string;
}
