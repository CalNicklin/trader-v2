// Placeholder — full task list added by Task 2 implementation.
// ClassifierReference is the reference schema for classifier eval grading.

export interface ClassifierInput {
	headline: string;
	symbol: string;
}

export interface ClassifierReference {
	tradeable: boolean;
	sentimentDirection: "positive" | "negative" | "neutral";
	sentimentMin: number;
	sentimentMax: number;
	expectedEventTypes: string[];
	expectedUrgency: "low" | "medium" | "high";
}

export const classifierTasks: import("../types.ts").EvalTask<
	ClassifierInput,
	ClassifierReference
>[] = [];
