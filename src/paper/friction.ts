import { getTradeFriction } from "../utils/fx.ts";

/**
 * Break-even-bps friction gate (TRA-15).
 *
 * At small notional, fixed per-trade commission dominates the percentage
 * rate. A 1-share HSBA buy at ~1000p pays the £1 broker commission floor on
 * ~£10 notional — that's 1000 bps one-way, guaranteed to eat any realistic
 * edge. This module exposes an "effective one-way friction in bps" computation
 * that includes the commission floor, plus the gate threshold.
 */

/** Reject entries where the effective one-way friction exceeds this. */
export const MAX_ONE_WAY_FRICTION_BPS = 75;

/**
 * Minimum per-trade commission, expressed in the venue's trade currency.
 * IBKR retail-tier rates sit around £1 / $1 / €1 — slightly conservative is
 * fine because rejecting at 75 bps is already a generous ceiling.
 */
const FIXED_COMMISSION_FLOOR_UNITS = 1;

/**
 * Return the expected one-way friction for filling `notional` currency units
 * on the given venue+side, expressed in basis points. Accounts for both the
 * percentage rate (stamp + average commission) and the absolute per-trade
 * commission floor.
 */
export function getEffectiveOneWayFrictionBps(
	exchange: string,
	side: "BUY" | "SELL",
	notional: number,
): number {
	if (notional <= 0) return Infinity;
	const rateBps = getTradeFriction(exchange, side) * 10_000;
	const commissionFloorBps = (FIXED_COMMISSION_FLOOR_UNITS / notional) * 10_000;
	// Take the max: whichever is higher binds. (The rate already nominally
	// includes commission at "sufficient" notional, but at tiny notional the
	// fixed floor exceeds what the rate would produce.)
	return Math.max(rateBps, commissionFloorBps);
}

/**
 * Whether a proposed entry fill would breach the per-side friction budget.
 * Used by the position-sizer to reject pathologically-small positions before
 * they can open.
 */
export function exceedsEdgeBudget(
	exchange: string,
	side: "BUY" | "SELL",
	notional: number,
): boolean {
	return getEffectiveOneWayFrictionBps(exchange, side, notional) > MAX_ONE_WAY_FRICTION_BPS;
}
