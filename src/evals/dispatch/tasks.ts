export interface DispatchEvalTask {
	id: string;
	description: string;
	regime: {
		atr_percentile: number;
		volume_breadth: number;
		momentum_regime: number;
	};
	strategies: {
		id: number;
		name: string;
		type: string;
		sharpe: number;
	}[];
	symbols: string[];
	recentNews: {
		symbol: string;
		headline: string;
		sentiment: number;
		eventType: string;
	}[];
	expectedActivations: { strategyId: number; symbol: string }[];
}

export const DISPATCH_EVAL_TASKS: DispatchEvalTask[] = [
	{
		id: "trending-regime-momentum",
		description: "High momentum regime — should prefer momentum strategies over mean reversion",
		regime: { atr_percentile: 70, volume_breadth: 0.8, momentum_regime: 0.85 },
		strategies: [
			{ id: 1, name: "momentum_breakout_v1", type: "momentum", sharpe: 1.2 },
			{
				id: 2,
				name: "mean_reversion_rsi_v1",
				type: "mean_reversion",
				sharpe: 0.9,
			},
		],
		symbols: ["AAPL", "MSFT", "GOOGL"],
		recentNews: [],
		expectedActivations: [
			{ strategyId: 1, symbol: "AAPL" },
			{ strategyId: 1, symbol: "MSFT" },
			{ strategyId: 1, symbol: "GOOGL" },
		],
	},
	{
		id: "choppy-regime-mean-reversion",
		description: "Low momentum (choppy) regime — should prefer mean reversion",
		regime: { atr_percentile: 30, volume_breadth: 0.4, momentum_regime: 0.2 },
		strategies: [
			{ id: 1, name: "momentum_breakout_v1", type: "momentum", sharpe: 1.2 },
			{
				id: 2,
				name: "mean_reversion_rsi_v1",
				type: "mean_reversion",
				sharpe: 0.9,
			},
		],
		symbols: ["AAPL", "MSFT"],
		recentNews: [],
		expectedActivations: [
			{ strategyId: 2, symbol: "AAPL" },
			{ strategyId: 2, symbol: "MSFT" },
		],
	},
	{
		id: "earnings-news-earnings-strategy",
		description: "Earnings news should route to earnings strategy",
		regime: { atr_percentile: 50, volume_breadth: 0.5, momentum_regime: 0.5 },
		strategies: [
			{ id: 1, name: "momentum_breakout_v1", type: "momentum", sharpe: 1.0 },
			{ id: 3, name: "earnings_drift_v1", type: "earnings", sharpe: 0.8 },
		],
		symbols: ["AAPL", "MSFT"],
		recentNews: [
			{
				symbol: "AAPL",
				headline: "Apple beats Q2 earnings estimates by 15%",
				sentiment: 0.85,
				eventType: "earnings_beat",
			},
		],
		expectedActivations: [{ strategyId: 3, symbol: "AAPL" }],
	},
];
