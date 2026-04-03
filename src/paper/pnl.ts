import { getTradeFriction } from "../utils/fx.ts";

const MIN_POSITION_VALUE = 50;

export function calcFriction(
	positionValue: number,
	exchange: string,
	side: "BUY" | "SELL",
): number {
	const frictionPct = getTradeFriction(exchange, side);
	return positionValue * frictionPct;
}

export function calcPositionSize(
	virtualBalance: number,
	positionSizePct: number,
	price: number,
): { quantity: number; positionValue: number } {
	const targetValue = virtualBalance * (positionSizePct / 100);
	if (targetValue < MIN_POSITION_VALUE) {
		return { quantity: 0, positionValue: 0 };
	}
	const quantity = Math.floor(targetValue / price);
	return { quantity, positionValue: quantity * price };
}

export function calcPnl(
	side: "BUY" | "SELL",
	quantity: number,
	entryPrice: number,
	exitPrice: number,
	entryFrictionPct: number,
	exitFrictionPct: number,
): number {
	const grossPnl =
		side === "BUY" ? (exitPrice - entryPrice) * quantity : (entryPrice - exitPrice) * quantity;
	const entryFriction = quantity * entryPrice * entryFrictionPct;
	const exitFriction = quantity * exitPrice * exitFrictionPct;
	return grossPnl - entryFriction - exitFriction;
}
