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
	// === Profitable trades with issues (should detect problems) ===
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
		tags: ["trade_review", "earnings", "profitable", "early_exit"],
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
		tags: ["trade_review", "gap_fade", "loss", "filter_failure"],
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
	// === More early exit scenarios ===
	{
		id: "tr-004",
		name: "Earnings drift truncated on NVDA",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: NVDA (NASDAQ)
Side: BUY
Entry: 800.00 → Exit: 820.00
PnL: 195.00 (after 5.00 friction)
Hold: 1 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.7 AND rsi14 < 30
News at entry: NVIDIA beats earnings by 40%, data center revenue triples YoY`,
		},
		reference: {
			expectedTags: ["earnings_drift_truncated", "early_exit"],
			expectedQuality: "good_entry_early_exit",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "earnings", "early_exit"],
	},
	{
		id: "tr-005",
		name: "FDA approval held only 1 day",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: MRNA (NASDAQ)
Side: BUY
Entry: 120.00 → Exit: 126.00
PnL: 58.50 (after 1.50 friction)
Hold: 1 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.7 AND rsi14 < 40
News at entry: Moderna receives FDA approval for new RSV vaccine`,
		},
		reference: {
			expectedTags: ["early_exit"],
			expectedQuality: "good_entry_early_exit",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "fda", "early_exit"],
	},
	// === Fundamental gap / filter failure ===
	{
		id: "tr-006",
		name: "Shorted gap on acquisition news",
		input: {
			tradePrompt: `Strategy: gap_fade_v1
Symbol: VMW (NASDAQ)
Side: SELL
Entry: 180.00 → Exit: 195.00
PnL: -150.40 (after 0.40 friction)
Hold: 1 day(s)
Signal: entry_short — Entry signal: change_percent > 3 AND news_sentiment < 0.3
News at entry: Broadcom completes $69B acquisition of VMware`,
		},
		reference: {
			expectedTags: ["fundamental_gap", "filter_failure"],
			expectedQuality: "bad_signal",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "gap_fade", "loss", "acquisition"],
	},
	{
		id: "tr-007",
		name: "Shorted gap on major contract win",
		input: {
			tradePrompt: `Strategy: gap_fade_v1
Symbol: PLTR (NASDAQ)
Side: SELL
Entry: 25.00 → Exit: 28.50
PnL: -350.80 (after 0.80 friction)
Hold: 1 day(s)
Signal: entry_short — Entry signal: change_percent > 4 AND news_sentiment < 0.4
News at entry: Palantir wins $500M US Army contract for battlefield AI`,
		},
		reference: {
			expectedTags: ["fundamental_gap", "filter_failure"],
			expectedQuality: "bad_signal",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "gap_fade", "loss", "contract"],
	},
	// === Stop too tight ===
	{
		id: "tr-008",
		name: "Stopped out before thesis played out",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: AMZN (NASDAQ)
Side: BUY
Entry: 180.00 → Exit: 177.00
PnL: -31.00 (after 1.00 friction)
Hold: 0 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.7 AND rsi14 < 30
News at entry: Amazon AWS revenue up 25%, new AI services announced`,
		},
		reference: {
			expectedTags: ["stop_too_tight"],
			expectedQuality: "stopped_out_correct",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "stopped_out", "stop_tight"],
	},
	{
		id: "tr-009",
		name: "Stopped out on intraday noise good thesis",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: GOOG (NASDAQ)
Side: BUY
Entry: 150.00 → Exit: 147.50
PnL: -25.50 (after 0.50 friction)
Hold: 0 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.8 AND rsi14 < 25
News at entry: Google DeepMind announces major AI breakthrough, Gemini 3.0 launch`,
		},
		reference: {
			expectedTags: ["stop_too_tight"],
			expectedQuality: "stopped_out_correct",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "stopped_out", "stop_tight"],
	},
	// === Clean profitable trades (no issues) ===
	{
		id: "tr-010",
		name: "Clean 3-day earnings hold",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: META (NASDAQ)
Side: BUY
Entry: 500.00 → Exit: 530.00
PnL: 295.00 (after 5.00 friction)
Hold: 3 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.7 AND rsi14 < 30
News at entry: Meta Q4 revenue up 25%, Reality Labs losses narrow`,
		},
		reference: {
			expectedTags: [],
			expectedQuality: "clean_profit",
			shouldSuggestAdjustment: false,
		},
		tags: ["trade_review", "clean", "profitable"],
	},
	{
		id: "tr-011",
		name: "Clean gap fade on no-news gap",
		input: {
			tradePrompt: `Strategy: gap_fade_v1
Symbol: SPY (NASDAQ)
Side: SELL
Entry: 520.00 → Exit: 516.00
PnL: 39.00 (after 1.00 friction)
Hold: 1 day(s)
Signal: entry_short — Entry signal: change_percent > 1.5 AND news_sentiment < 0.2
News at entry: No significant news`,
		},
		reference: {
			expectedTags: [],
			expectedQuality: "clean_profit",
			shouldSuggestAdjustment: false,
		},
		tags: ["trade_review", "clean", "gap_fade", "profitable"],
	},
	{
		id: "tr-012",
		name: "Clean profitable short on bad earnings",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: SNAP (NASDAQ)
Side: SELL
Entry: 15.00 → Exit: 12.50
PnL: 247.50 (after 2.50 friction)
Hold: 3 day(s)
Signal: entry_short — Entry signal: news_sentiment < -0.7 AND rsi14 > 70
News at entry: Snap misses Q3 revenue and user growth estimates, cuts guidance`,
		},
		reference: {
			expectedTags: [],
			expectedQuality: "clean_profit",
			shouldSuggestAdjustment: false,
		},
		tags: ["trade_review", "clean", "short", "profitable"],
	},
	// === Regime mismatch ===
	{
		id: "tr-013",
		name: "Mean reversion fails in bear trend",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: AAPL (NASDAQ)
Side: BUY
Entry: 170.00 → Exit: 160.00
PnL: -101.00 (after 1.00 friction)
Hold: 3 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.5 AND rsi14 < 30
News at entry: Apple reports slight revenue beat but iPhone sales flat
Note: Broader market in sustained downtrend, SPY down 8% over past month`,
		},
		reference: {
			expectedTags: ["regime_mismatch"],
			expectedQuality: "regime_mismatch",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "loss", "regime"],
	},
	// === Profitable but improvable (early exit on strong catalyst) ===
	{
		id: "tr-014",
		name: "Tiny profit on major catalyst 5-day hold",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: AMD (NASDAQ)
Side: BUY
Entry: 150.00 → Exit: 152.00
PnL: 18.00 (after 2.00 friction)
Hold: 5 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.8 AND rsi14 < 25
News at entry: AMD launches MI400 AI chip, secures major Microsoft deal
Note: Stock reached 170.00 intraday on day 2 before pulling back`,
		},
		reference: {
			expectedTags: ["stop_too_loose"],
			expectedQuality: "profitable_but_improvable",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "profitable", "stop_loose"],
	},
	// === Size too large ===
	{
		id: "tr-015",
		name: "Large loss amplified by position size",
		input: {
			tradePrompt: `Strategy: gap_fade_v1
Symbol: RIVN (NASDAQ)
Side: SELL
Entry: 18.00 → Exit: 22.00
PnL: -2001.00 (after 1.00 friction)
Hold: 2 day(s)
Signal: entry_short — Entry signal: change_percent > 5 AND news_sentiment < 0.3
News at entry: Rivian secures $5B investment from Volkswagen`,
		},
		reference: {
			expectedTags: ["fundamental_gap", "size_too_large"],
			expectedQuality: "bad_signal",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "loss", "size", "fundamental"],
	},
	// === Mixed: profitable but with catalyst ignored ===
	{
		id: "tr-016",
		name: "Shorted against positive guidance",
		input: {
			tradePrompt: `Strategy: gap_fade_v1
Symbol: CRM (NASDAQ)
Side: SELL
Entry: 300.00 → Exit: 310.00
PnL: -102.00 (after 2.00 friction)
Hold: 1 day(s)
Signal: entry_short — Entry signal: change_percent > 3 AND news_sentiment < 0.3
News at entry: Salesforce raises full-year guidance, announces $10B buyback`,
		},
		reference: {
			expectedTags: ["catalyst_ignored", "fundamental_gap"],
			expectedQuality: "bad_signal",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "loss", "catalyst"],
	},
	// === Stop too loose — was profitable then gave it all back ===
	{
		id: "tr-017",
		name: "Profitable trade turned loss, no trailing stop",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: COIN (NASDAQ)
Side: BUY
Entry: 250.00 → Exit: 235.00
PnL: -153.00 (after 3.00 friction)
Hold: 4 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.6 AND rsi14 < 35
News at entry: Coinbase reports strong Q4 trading volume
Note: Stock hit 275.00 on day 1 before reversing sharply over next 3 days`,
		},
		reference: {
			expectedTags: ["stop_too_loose"],
			expectedQuality: "profitable_but_improvable",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "loss", "stop_loose"],
	},
	// === LSE trades (pence pricing) ===
	{
		id: "tr-018",
		name: "Clean LSE trade in pence",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: SHEL (LSE)
Side: BUY
Entry: 2650.00 → Exit: 2750.00
PnL: 98.00 (after 2.00 friction)
Hold: 3 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.7 AND rsi14 < 30
News at entry: Shell announces record quarterly profit, raises dividend 15%`,
		},
		reference: {
			expectedTags: [],
			expectedQuality: "clean_profit",
			shouldSuggestAdjustment: false,
		},
		tags: ["trade_review", "clean", "lse", "profitable"],
	},
	// === Bad signal, no news context ===
	{
		id: "tr-019",
		name: "Loss with no news context",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: ROKU (NASDAQ)
Side: BUY
Entry: 70.00 → Exit: 64.00
PnL: -61.00 (after 1.00 friction)
Hold: 2 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.5 AND rsi14 < 30`,
		},
		reference: {
			expectedTags: ["regime_mismatch"],
			expectedQuality: "bad_signal",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "loss", "no_news"],
	},
	// === Another clean trade ===
	{
		id: "tr-020",
		name: "Clean multi-day hold on upgrade",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: NFLX (NASDAQ)
Side: BUY
Entry: 600.00 → Exit: 640.00
PnL: 394.00 (after 6.00 friction)
Hold: 4 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.8 AND rsi14 < 30
News at entry: Netflix subscriber growth beats estimates, ad tier exceeds expectations`,
		},
		reference: {
			expectedTags: [],
			expectedQuality: "clean_profit",
			shouldSuggestAdjustment: false,
		},
		tags: ["trade_review", "clean", "profitable"],
	},
];
