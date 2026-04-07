export interface ImprovementIdea {
	title: string;
	description: string;
	targetFile: string;
	changeDescription: string;
	reasoning: string;
	priority: "low" | "medium" | "high";
}

export interface ProposalResult {
	prsCreated: number;
	errors: string[];
}
