import type { StrategyPerformance } from "../evolution/types.ts";
import type { RegimeSignals } from "./regime.ts";

export function buildDispatchPrompt(
	graduatedStrategies: StrategyPerformance[],
	regime: RegimeSignals,
	recentNews: { symbol: string; headline: string; sentiment: number; eventType: string }[],
): string {
	const strategySummaries = graduatedStrategies
		.map((s) => {
			const metrics = s.metrics
				? `Sharpe=${s.metrics.sharpeRatio?.toFixed(2) ?? "N/A"}, PF=${s.metrics.profitFactor?.toFixed(2) ?? "N/A"}, WR=${s.metrics.winRate != null ? (s.metrics.winRate * 100).toFixed(0) : "N/A"}%, Trades=${s.metrics.sampleSize}`
				: "No metrics yet";
			return `- Strategy #${s.id} "${s.name}" (gen ${s.generation}, created by ${s.createdBy})
  Signals: entry_long="${s.signals.entry_long || "none"}", entry_short="${s.signals.entry_short || "none"}", exit="${s.signals.exit || "none"}"
  Universe: [${s.universe.join(", ")}]
  Metrics: ${metrics}`;
		})
		.join("\n");

	const newsSummary =
		recentNews.length > 0
			? recentNews
					.map(
						(n) => `- ${n.symbol}: "${n.headline}" (sentiment=${n.sentiment}, type=${n.eventType})`,
					)
					.join("\n")
			: "No significant recent news.";

	return `You are the strategy dispatcher for a trading system. Your job is to decide which graduated strategies should be actively evaluated on which symbols RIGHT NOW, given current market conditions.

## Current Market Regime
- ATR Percentile: ${regime.atr_percentile.toFixed(0)} (0=calm, 100=volatile)
- Volume Breadth: ${(regime.volume_breadth * 100).toFixed(0)}% of universe above average volume
- Momentum Regime: ${regime.momentum_regime.toFixed(2)} (0=mean-reverting, 1=trending)

## Graduated Strategies
${strategySummaries}

## Recent News (last 4 hours)
${newsSummary}

## Your Task

For each strategy-symbol combination, decide whether to ACTIVATE (the strategy's signals will be evaluated on this symbol during the next evaluation cycle) or SKIP (do not evaluate).

Consider:
- Does the current regime match the strategy's edge? (e.g., momentum strategies in trending regime, mean-reversion in choppy regime)
- Does the symbol have relevant news that aligns with the strategy type?
- Is the strategy's historical performance strong enough to warrant activation?

Output JSON only:
{
  "decisions": [
    { "strategyId": <number>, "symbol": "<string>", "action": "activate" | "skip", "reasoning": "<brief>" }
  ]
}

Only include decisions for strategy-symbol pairs you have an opinion on. If a strategy should run on its full universe unchanged, you can omit it — the default is to evaluate all symbols in the strategy's universe.`;
}
