import type { StrategyPerformance } from "../evolution/types.ts";

export interface CatalystNews {
	headline: string;
	sentiment: number;
	urgency: "low" | "medium" | "high";
	eventType: string;
}

export function buildCatalystPrompt(
	symbol: string,
	graduatedStrategies: StrategyPerformance[],
	news: CatalystNews,
): string {
	const strategySummaries = graduatedStrategies
		.map((s) => {
			const metrics = s.metrics
				? `Sharpe=${s.metrics.sharpeRatio?.toFixed(2) ?? "N/A"}, PF=${s.metrics.profitFactor?.toFixed(2) ?? "N/A"}, WR=${s.metrics.winRate != null ? (s.metrics.winRate * 100).toFixed(0) : "N/A"}%, Trades=${s.metrics.sampleSize}`
				: "No metrics yet";
			const inUniverse = s.universe.some((u) => u === symbol || u.startsWith(`${symbol}:`));
			return `- Strategy #${s.id} "${s.name}" (gen ${s.generation}, by ${s.createdBy}, status=${s.status})
  Signals: entry_long="${s.signals.entry_long || "none"}", entry_short="${s.signals.entry_short || "none"}", exit="${s.signals.exit || "none"}"
  Universe includes ${symbol}: ${inUniverse ? "YES" : "NO"}
  Metrics: ${metrics}`;
		})
		.join("\n");

	return `You are the catalyst-triggered dispatcher for a trading system.

A high-urgency news catalyst just landed on ${symbol}. Decide which graduated strategies should evaluate ${symbol} in the next few hours.

## Catalyst
- Symbol: ${symbol}
- Headline: "${news.headline}"
- Event type: ${news.eventType}
- Urgency: ${news.urgency}
- Sentiment: ${news.sentiment.toFixed(2)} (-1=very bearish, +1=very bullish)

## Graduated Strategies
${strategySummaries}

## Your Task

For each strategy, decide whether to ACTIVATE it on ${symbol} (so the next evaluator tick will check its signals on this symbol) or SKIP it.

Consider:
- Does the strategy's signal logic likely engage given this catalyst direction and sentiment?
- Does the strategy's historical edge align with catalyst-driven moves (momentum strategies usually do well on strong catalysts; mean-reverters often do poorly)?
- If the symbol is not in the strategy's universe, activation will still cause the evaluator to consider it via universe injection — decide based on fit, not mere membership.

Output JSON only:
{
  "decisions": [
    { "strategyId": <number>, "symbol": "${symbol}", "action": "activate" | "skip", "reasoning": "<brief>" }
  ]
}

Include a decision for every strategy listed.`;
}
