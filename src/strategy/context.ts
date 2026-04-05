import type { ExprContext } from "./expr-eval.ts";
import type { SymbolIndicators } from "./historical.ts";

export interface QuoteFields {
	last: number | null;
	bid: number | null;
	ask: number | null;
	volume: number | null;
	avgVolume: number | null;
	changePercent: number | null;
	newsSentiment: number | null;
	newsEarningsSurprise: number | null;
	newsGuidanceChange: number | null;
	newsManagementTone: number | null;
	newsRegulatoryRisk: number | null;
	newsAcquisitionLikelihood: number | null;
	newsCatalystType: string | null;
	newsExpectedMoveDuration: string | null;
}

export interface PositionFields {
	entryPrice: number;
	openedAt: string;
	quantity: number;
}

export interface ContextInput {
	quote: QuoteFields;
	indicators: SymbolIndicators;
	position: PositionFields | null;
}

export function buildSignalContext(input: ContextInput): ExprContext {
	const { quote, indicators, position } = input;

	let holdDays: number | null = null;
	let pnlPct: number | null = null;

	if (position) {
		const openedAt = new Date(position.openedAt);
		const now = new Date();
		holdDays = Math.floor((now.getTime() - openedAt.getTime()) / (1000 * 60 * 60 * 24));

		if (quote.last != null && position.entryPrice > 0) {
			pnlPct = ((quote.last - position.entryPrice) / position.entryPrice) * 100;
		}
	}

	return {
		last: quote.last,
		bid: quote.bid,
		ask: quote.ask,
		volume: quote.volume,
		avg_volume: quote.avgVolume,
		change_percent: quote.changePercent,
		news_sentiment: quote.newsSentiment,
		earnings_surprise: quote.newsEarningsSurprise,
		guidance_change: quote.newsGuidanceChange,
		management_tone: quote.newsManagementTone,
		regulatory_risk: quote.newsRegulatoryRisk,
		acquisition_likelihood: quote.newsAcquisitionLikelihood,
		rsi14: indicators.rsi14,
		atr14: indicators.atr14,
		volume_ratio: indicators.volume_ratio,
		hold_days: holdDays,
		pnl_pct: pnlPct,
	};
}
