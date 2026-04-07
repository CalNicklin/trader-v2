export interface TradeForReview {
	tradeId: number;
	strategyId: number;
	strategyName: string;
	symbol: string;
	exchange: string;
	side: "BUY" | "SELL";
	quantity: number;
	entryPrice: number;
	exitPrice: number;
	pnl: number;
	friction: number;
	holdDays: number;
	signalType: string;
	reasoning: string | null;
	newsContextAtEntry: string | null;
}

export interface TradeReviewResult {
	tradeId: number;
	outcomeQuality: string;
	whatWorked: string;
	whatFailed: string;
	patternTags: string[];
	suggestedParameterAdjustment: {
		parameter: string;
		direction: "increase" | "decrease" | "none";
		reasoning: string;
	} | null;
	marketContext: string;
	confidence: number;
}

export interface PatternObservation {
	strategyId: number;
	patternType: string;
	observation: string;
	affectedSymbols: string[];
	tags: string[];
	suggestedAction: {
		parameter: string;
		direction: "increase" | "decrease" | "none";
		reasoning: string;
	} | null;
	confidence: number;
}

export interface PatternAnalysisResult {
	observations: PatternObservation[];
	timestamp: string;
}

export interface GraduationReviewInput {
	strategyId: number;
	strategyName: string;
	metrics: {
		sampleSize: number;
		winRate: number | null;
		expectancy: number | null;
		profitFactor: number | null;
		sharpeRatio: number | null;
		maxDrawdownPct: number | null;
		consistencyScore: number | null;
	};
	recentTrades: Array<{
		symbol: string;
		side: string;
		pnl: number | null;
		createdAt: string;
	}>;
	patternInsights: string[];
}

export interface GraduationReviewResult {
	recommendation: "graduate" | "hold" | "concerns";
	confidence: number;
	reasoning: string;
	riskFlags: string[];
	suggestedConditions: string;
}

export interface UniverseSuggestion {
	symbol: string;
	exchange: string;
	reason: string;
	evidenceCount: number;
}
