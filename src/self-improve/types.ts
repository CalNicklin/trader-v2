export const WHITELISTED_PATHS = [
	"src/strategy/evaluation/",
	"src/strategy/signals/",
	"src/news/classifier.ts",
	"src/reporting/",
	"src/evolution/prompt.ts",
] as const;

export const HUMAN_ONLY_PATHS = [
	"src/risk/",
	"src/strategy/graduation/",
	"src/broker/",
	"src/db/schema.ts",
	"drizzle/",
] as const;

export const MAX_PRS_PER_WEEK = 2;
export const MAX_ISSUES_PER_WEEK = 3;

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
	issuesCreated: number;
	skipped: number;
	errors: string[];
}
