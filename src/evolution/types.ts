export interface StrategyPerformance {
	id: number;
	name: string;
	status: string;
	generation: number;
	parentStrategyId: number | null;
	createdBy: string;
	parameters: Record<string, number>;
	signals: SignalDef;
	universe: string[];
	metrics: MetricsSummary | null;
	recentTrades: TradeSummary[];
	virtualBalance: number;
	insightSummary: string[];
	suggestedActions: SuggestedAction[];
}

export interface SuggestedAction {
	parameter: string;
	direction: "increase" | "decrease" | "none";
	reasoning: string;
}

export interface SignalDef {
	entry_long?: string;
	entry_short?: string;
	exit?: string;
}

export interface MetricsSummary {
	sampleSize: number;
	winRate: number | null;
	expectancy: number | null;
	profitFactor: number | null;
	sharpeRatio: number | null;
	sortinoRatio: number | null;
	maxDrawdownPct: number | null;
	calmarRatio: number | null;
	consistencyScore: number | null;
}

export interface TradeSummary {
	symbol: string;
	side: string;
	pnl: number | null;
	createdAt: string;
}

export interface MissedOpportunity {
	symbol: string;
	observation: string;
	confidence: number;
}

export interface PerformanceLandscape {
	strategies: StrategyPerformance[];
	activePaperCount: number;
	missedOpportunities: MissedOpportunity[];
	timestamp: string;
}

export interface MutationProposal {
	parentId: number;
	type: "parameter_tweak" | "new_variant" | "structural";
	name: string;
	description: string;
	parameters: Record<string, number>;
	signals?: SignalDef;
	universe?: string[];
	reasoning: string;
}

export interface ValidatedMutation {
	parentId: number;
	type: "parameter_tweak" | "new_variant" | "structural";
	name: string;
	description: string;
	parameters: Record<string, number>;
	signals: SignalDef;
	universe: string[];
	parameterDiff: Record<string, { from: number; to: number }>;
}

export interface TournamentResult {
	parentId: number;
	childId: number;
	parentSharpe: number;
	childSharpe: number;
	winnerId: number;
	loserId: number;
	reason: string;
}
