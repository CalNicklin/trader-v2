export interface StableEdgeInput {
	sampleSize: number;
	sharpeRatio: number | null;
	backHalfPnl: number; // sum of pnl over most recent 50% of closed trades
}

export const MIN_SAMPLE_PROMOTE = 15;
export const MIN_SAMPLE_RETIRE = 20;

/**
 * Shared sample-quality predicate used by both the graduation gate and the
 * expectancy-kill path. Requires the back-half of the trade history to
 * confirm the full-sample Sharpe sign — this blocks regime-lucky promotion
 * (e.g. strategy 3's n=3 AI-rally wins) and regime-unlucky retirement
 * (e.g. strategy 1's n=7 shorts-into-rally losses).
 */
export function hasStableEdge(input: StableEdgeInput, direction: "promote" | "retire"): boolean {
	if (input.sharpeRatio == null) return false;

	const minSample = direction === "promote" ? MIN_SAMPLE_PROMOTE : MIN_SAMPLE_RETIRE;
	if (input.sampleSize < minSample) return false;

	const fullSignPositive = input.sharpeRatio > 0;
	const backHalfSignPositive = input.backHalfPnl > 0;

	if (direction === "promote") {
		return fullSignPositive && backHalfSignPositive;
	}
	return !fullSignPositive && !backHalfSignPositive;
}
