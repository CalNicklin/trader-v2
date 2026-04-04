import type { EvalTask } from "../types.ts";

interface TradeReviewInput {
	tradePrompt: string;
}

interface TradeReviewReference {
	expectedTags: string[];
	expectedQuality: string;
	shouldSuggestAdjustment: boolean;
}

export const tradeReviewTasks: EvalTask<TradeReviewInput, TradeReviewReference>[] = [
	{
		id: "tr-001",
		name: "Profitable earnings trade with early exit",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: AAPL (NASDAQ)
Side: BUY
Entry: 150.00 → Exit: 155.00
PnL: 49.50 (after 0.50 friction)
Hold: 1 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.7 AND rsi14 < 30
News at entry: Apple beats Q4 earnings, raises guidance by 15%`,
		},
		reference: {
			expectedTags: ["earnings_drift_truncated", "early_exit"],
			expectedQuality: "good_entry_early_exit",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "earnings", "profitable"],
	},
	{
		id: "tr-002",
		name: "Loss on gap fade that was fundamental",
		input: {
			tradePrompt: `Strategy: gap_fade_v1
Symbol: TSLA (NASDAQ)
Side: SELL
Entry: 250.00 → Exit: 265.00
PnL: -150.00 (after 0.60 friction)
Hold: 1 day(s)
Signal: entry_short — Entry signal: change_percent > 2 AND news_sentiment < 0.3
News at entry: Tesla announces new Gigafactory in India, production to begin 2027`,
		},
		reference: {
			expectedTags: ["fundamental_gap", "filter_failure"],
			expectedQuality: "bad_signal",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "gap_fade", "loss"],
	},
	{
		id: "tr-003",
		name: "Clean profitable trade no issues",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: MSFT (NASDAQ)
Side: BUY
Entry: 400.00 → Exit: 412.00
PnL: 118.00 (after 2.00 friction)
Hold: 3 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.7 AND rsi14 < 30
News at entry: Microsoft cloud revenue surges 30%, beats estimates`,
		},
		reference: {
			expectedTags: [],
			expectedQuality: "clean_profit",
			shouldSuggestAdjustment: false,
		},
		tags: ["trade_review", "clean", "profitable"],
	},
];
