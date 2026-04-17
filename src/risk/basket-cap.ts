import { MAX_CONCURRENT_POSITIONS } from "./constants.ts";

/**
 * Check whether a single dispatch tick's proposed opens would breach the
 * concurrent-position cap. On 2026-04-08 strategy 2 opened 7 correlated shorts
 * in one tick because the gate read openPositionCount once up-front and
 * never incremented it as opens succeeded. This helper lets the evaluator
 * reject the entire tick when a basket would breach, rather than silently
 * admitting 3 of N by insert-order.
 */
export function tickWouldBreachCap(
	existingOpen: number,
	proposedOpens: number,
	cap: number = MAX_CONCURRENT_POSITIONS,
): boolean {
	return existingOpen + proposedOpens > cap;
}
