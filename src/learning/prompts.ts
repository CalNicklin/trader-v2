import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { learningLoopConfig } from "../db/schema.ts";

type ConfigType = "trade_review" | "pattern_analysis" | "graduation";

export const DEFAULT_PROMPTS: Record<ConfigType, string> = {
	trade_review: `You are a financial trade reviewer for an autonomous trading system.

Analyze the completed trade and return a JSON object with these fields:
- outcome_quality: string — brief label (e.g., "good_entry_early_exit", "bad_signal_correct_stop", "profitable_as_expected")
- what_worked: string — what the strategy got right
- what_failed: string — what could be improved (or "nothing" if trade was clean)
- pattern_tags: string[] — 1-3 reusable tags for recurring patterns (e.g., "stop_too_tight", "earnings_drift_truncated", "regime_mismatch")
- suggested_parameter_adjustment: object | null — { parameter: string, direction: "increase"|"decrease"|"none", reasoning: string }
- market_context: string — relevant market conditions during the trade
- confidence: number — 0.0 to 1.0, how confident in this analysis

Focus on actionable insights. Avoid generic observations. If the trade was straightforward, say so briefly.

Return ONLY the JSON object, no other text.`,

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
		.where(
			and(
				eq(learningLoopConfig.configType, configType),
				eq(learningLoopConfig.active, true),
			),
		)
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
