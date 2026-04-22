// src/risk/position-sizer.ts
import { exceedsEdgeBudget, MAX_ONE_WAY_FRICTION_BPS } from "../paper/friction.ts";
import { getTradeFriction } from "../utils/fx.ts";
import {
	MAX_SHORT_SIZE_RATIO,
	MIN_POSITION_VALUE,
	RISK_PER_TRADE_PCT,
	STOP_LOSS_ATR_MULT_LONG,
	STOP_LOSS_ATR_MULT_SHORT,
	WEEKLY_DRAWDOWN_SIZE_REDUCTION,
} from "./constants.ts";

export interface PositionSizeInput {
	accountBalance: number;
	price: number;
	atr14: number;
	side: "BUY" | "SELL";
	exchange: string;
	weeklyDrawdownActive?: boolean;
}

export interface PositionSizeResult {
	quantity: number;
	positionValue: number;
	stopLossPrice: number;
	riskAmount: number;
	friction: number;
	skipped: boolean;
	skipReason?: string;
}

export function calcStopLossPrice(price: number, atr14: number, side: "BUY" | "SELL"): number {
	const multiplier = side === "BUY" ? STOP_LOSS_ATR_MULT_LONG : STOP_LOSS_ATR_MULT_SHORT;
	const stopDistance = atr14 * multiplier;

	if (side === "BUY") {
		return Math.max(price - stopDistance, 0.01);
	}
	return price + stopDistance;
}

export function calcAtrPositionSize(input: PositionSizeInput): PositionSizeResult {
	const { accountBalance, price, atr14, side, exchange, weeklyDrawdownActive } = input;

	const skippedResult = (reason: string): PositionSizeResult => ({
		quantity: 0,
		positionValue: 0,
		stopLossPrice: side === "BUY" ? price : price,
		riskAmount: 0,
		friction: 0,
		skipped: true,
		skipReason: reason,
	});

	if (atr14 <= 0) return skippedResult("ATR is zero or negative");
	if (price <= 0) return skippedResult("Price is zero or negative");
	if (accountBalance <= 0) return skippedResult("Account balance is zero or negative");

	// Base risk calculation
	let riskBudget = accountBalance * RISK_PER_TRADE_PCT;

	// Shorts capped at 75% of max long risk
	if (side === "SELL") {
		riskBudget *= MAX_SHORT_SIZE_RATIO;
	}

	// Weekly drawdown mode: reduce by 50%
	if (weeklyDrawdownActive) {
		riskBudget *= WEEKLY_DRAWDOWN_SIZE_REDUCTION;
	}

	// Stop distance
	const multiplier = side === "BUY" ? STOP_LOSS_ATR_MULT_LONG : STOP_LOSS_ATR_MULT_SHORT;
	const stopDistance = atr14 * multiplier;

	// Friction cost per share
	const frictionPct = getTradeFriction(exchange, side);
	const frictionPerShare = price * frictionPct;

	// Shares from risk budget (accounting for both stop distance and friction)
	const riskPerShare = stopDistance + frictionPerShare;
	const rawShares = riskBudget / riskPerShare;
	const quantity = Math.floor(rawShares);

	if (quantity <= 0) {
		return skippedResult("Calculated quantity is zero (risk budget too small for stop distance)");
	}

	const positionValue = quantity * price;
	const friction = quantity * frictionPerShare;

	// Minimum position check (after friction)
	if (positionValue < MIN_POSITION_VALUE) {
		return skippedResult(
			`Position value $${positionValue.toFixed(2)} below minimum $${MIN_POSITION_VALUE}`,
		);
	}

	// TRA-15 break-even-bps gate. Rejects entries where the fixed commission
	// floor drives effective one-way friction above the 75 bps edge budget —
	// e.g. 1-share LSE buys where £1 commission dominates a <£133 notional.
	if (exceedsEdgeBudget(exchange, side, positionValue)) {
		return skippedResult(
			`FRICTION_EXCEEDS_EDGE_BUDGET: one-way friction on ${positionValue.toFixed(2)} ${exchange} exceeds ${MAX_ONE_WAY_FRICTION_BPS}bps`,
		);
	}

	const stopLossPrice = calcStopLossPrice(price, atr14, side);
	const actualRisk = quantity * stopDistance + friction;

	return {
		quantity,
		positionValue,
		stopLossPrice,
		riskAmount: actualRisk,
		friction,
		skipped: false,
	};
}
