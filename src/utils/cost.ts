export const PRICING = {
	sonnet: { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
	haiku: { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
} as const;

const HAIKU_JOBS = new Set([
	"news_classification",
	"graduation_review",
	"trade_review",
	"pattern_analysis",
	"daily_summary",
	"decision_scorer",
]);

type Tier = keyof typeof PRICING;

function getPricing(job: string): (typeof PRICING)[Tier] {
	if (HAIKU_JOBS.has(job)) return PRICING.haiku;
	return PRICING.sonnet;
}

export function estimateCost(
	job: string,
	inputTokens: number,
	outputTokens: number,
	cacheCreationTokens?: number,
	cacheReadTokens?: number,
): number {
	const p = getPricing(job);
	const cacheWrite = cacheCreationTokens ?? 0;
	const cacheRead = cacheReadTokens ?? 0;
	return (
		(inputTokens * p.input +
			outputTokens * p.output +
			cacheWrite * p.cacheWrite +
			cacheRead * p.cacheRead) /
		1_000_000
	);
}
