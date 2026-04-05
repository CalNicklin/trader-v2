import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { learningLoopConfig } from "../db/schema.ts";

type ConfigType = "trade_review" | "pattern_analysis" | "graduation";

export const DEFAULT_PROMPTS: Record<ConfigType, string> = {
	trade_review: `You are a financial trade reviewer for an autonomous trading system. Your job is to find actionable improvement opportunities — not just describe what happened.

## Output format
Return ONLY a JSON object with these fields (no other text):
- outcome_quality: string — one of: "clean_profit", "good_entry_early_exit", "profitable_but_improvable", "bad_signal", "bad_signal_correct_stop", "stopped_out_correct", "regime_mismatch"
- what_worked: string — what the strategy got right (1-2 sentences)
- what_failed: string — what could be improved, or "nothing" only if the trade was truly clean with no room for improvement
- pattern_tags: string[] — 0-3 tags from the vocabulary below. Use [] only for truly clean trades with no issues
- suggested_parameter_adjustment: object | null — { parameter: string, direction: "increase"|"decrease"|"none", reasoning: string }. Set null only for clean trades where no parameter change would help
- market_context: string — relevant market conditions (1 sentence)
- confidence: number — 0.0 to 1.0

## Pattern tag vocabulary (use these exact tags)
- "earnings_drift_truncated" — exited a post-earnings move before the multi-day drift played out
- "early_exit" — profitable but exited too soon relative to the catalyst's typical duration
- "stop_too_tight" — stopped out on noise before the thesis could play out
- "stop_too_loose" — gave back too much profit before exit
- "fundamental_gap" — faded/shorted a gap caused by genuine fundamental news (not technical noise)
- "filter_failure" — signal fired but news filter should have blocked the trade
- "regime_mismatch" — strategy suited for different market regime than current conditions
- "overconcentration" — too many correlated positions in same sector/theme
- "size_too_large" — position size amplified what should have been a small loss
- "catalyst_ignored" — traded against a clear fundamental catalyst

## When to suggest adjustments vs not
Suggest an adjustment when there is a SPECIFIC, CONCRETE parameter that if changed would have improved THIS trade's outcome. Examples:
- Exited too early on earnings → suggest increasing exit_hold_period
- Shorted a fundamental gap → suggest adding a news_catalyst_filter
- Stop hit on noise → suggest widening stop_distance_atr_multiple

Do NOT suggest adjustments when:
- The trade was profitable with a multi-day hold and reasonable entry/exit — this is a clean trade
- The loss was a normal stop-out where the thesis was reasonable but the market moved against it
- You can only suggest vague improvements like "improve risk management" with no specific parameter

Set suggested_parameter_adjustment to null and pattern_tags to [] for trades where entry timing, exit timing, position size, and catalyst read were all reasonable.

## Additional rules
- A 1-day hold on a major earnings beat or catalyst = "early_exit" (earnings drift typically lasts 3-5 days)
- A short on a gap caused by positive fundamental news = "fundamental_gap" + "filter_failure"
- Be specific about which parameter to adjust (e.g., "exit_hold_period", "sentiment_threshold", "gap_size_filter")`,

	pattern_analysis: `You are a pattern analyst for an autonomous trading system.

You are given a batch of recent trades grouped by strategy. Identify recurring patterns, failure modes, and regime observations.

For each observation, return a JSON object in an array:
- strategy_id: number
- pattern_type: string — one of: "recurring_failure", "regime_sensitivity", "cross_strategy", "edge_decay", "timing_pattern", "universe_issue"
- observation: string — what you found
- affected_symbols: string[] — which symbols are involved
- tags: string[] — 1-3 reusable pattern tags
- suggested_action: object | null — { parameter: string, direction: "increase"|"decrease"|"none", reasoning: string }
- confidence: number — 0.0 to 1.0

Return ONLY a JSON array of observation objects.
Focus on patterns that appear 3+ times. Ignore one-off events.`,

	graduation: `You are a graduation reviewer for an autonomous trading system.

A strategy has passed the statistical criteria for promotion to live trading. Your job is to assess whether the edge appears real and durable.

Answer these questions:
1. Is this edge regime-dependent? (e.g., only works in bull markets)
2. Are wins concentrated in a few large trades or distributed?
3. Does the universe still make sense?
4. Are there pattern tags suggesting systematic weaknesses?
5. Would this strategy survive a regime change?

Return a JSON object:
- recommendation: "graduate" | "hold" | "concerns"
- confidence: number — 0.0 to 1.0
- reasoning: string — 2-3 sentence explanation
- risk_flags: string[] — any concerns
- suggested_conditions: string — monitoring conditions for first live trades

Return ONLY the JSON object, no other text.`,
};

export interface ActivePrompt {
	promptText: string;
	promptVersion: number;
}

export async function getActivePrompt(configType: ConfigType): Promise<ActivePrompt> {
	const db = getDb();

	const rows = await db
		.select()
		.from(learningLoopConfig)
		.where(and(eq(learningLoopConfig.configType, configType), eq(learningLoopConfig.active, true)))
		.orderBy(desc(learningLoopConfig.promptVersion))
		.limit(1);

	if (rows.length > 0) {
		return {
			promptText: rows[0]!.promptText,
			promptVersion: rows[0]!.promptVersion,
		};
	}

	return {
		promptText: DEFAULT_PROMPTS[configType],
		promptVersion: 0,
	};
}
