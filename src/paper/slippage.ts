import { getConfig } from "../config.ts";

/**
 * Paper-engine slippage haircut (TRA-6).
 *
 * The live engine fills through IBKR at ask/bid + market impact; the paper
 * engine previously filled at `quote.last` (an approximation of mid) with no
 * slippage modelled. Graduation decisions based on slippage-blind Sharpe
 * over-rated strategies that will compress materially on real fills.
 *
 * This module applies a flat per-side haircut to every paper fill. 5 bps is
 * the Skeptic's deliberate simplification over a per-venue / per-session model
 * — one constant, trivially recalibratable from real fills once live.
 */

export function getPaperSlippageBps(): number {
	return getConfig().PAPER_SLIPPAGE_BPS;
}

/**
 * Apply slippage to an entry fill. BUY entries pay more, SELL entries (short
 * entries) receive less — the haircut always goes against the paper strategy.
 */
export function applyEntrySlippage(price: number, side: "BUY" | "SELL", bps: number): number {
	if (bps === 0) return price;
	const factor = 1 + (side === "BUY" ? 1 : -1) * (bps / 10_000);
	return price * factor;
}

/**
 * Apply slippage to an exit fill. The `exitSide` is the order side used to
 * close the position: SELL when closing a long, BUY when closing a short.
 * Haircut always goes against the paper strategy (close a long at a lower
 * price, close a short at a higher price).
 */
export function applyExitSlippage(price: number, exitSide: "BUY" | "SELL", bps: number): number {
	if (bps === 0) return price;
	const factor = 1 + (exitSide === "BUY" ? 1 : -1) * (bps / 10_000);
	return price * factor;
}
