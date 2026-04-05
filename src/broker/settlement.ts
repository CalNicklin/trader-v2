import type { Exchange } from "./contracts.ts";

/** Settlement rules by exchange region */
const SETTLEMENT_DAYS: Record<Exchange, number> = {
	LSE: 2, // T+2
	NASDAQ: 1, // T+1
	NYSE: 1, // T+1
};

export interface UnsettledTrade {
	fillPrice: number;
	quantity: number;
	side: "BUY" | "SELL";
	exchange: string;
	filledAt: string; // ISO date string
}

/**
 * Calculate the settlement date for a trade.
 * Skips weekends (Sat/Sun) but not bank holidays — conservative enough for safety.
 */
export function getSettlementDate(tradeDate: Date, exchange: Exchange): Date {
	const days = SETTLEMENT_DAYS[exchange];
	const result = new Date(tradeDate);
	let added = 0;
	while (added < days) {
		result.setDate(result.getDate() + 1);
		const dow = result.getDay();
		if (dow !== 0 && dow !== 6) {
			added++;
		}
	}
	return result;
}

/**
 * Calculate total unsettled cash tied up from recent trades.
 * A BUY that hasn't settled = cash outflow not yet debited.
 * A SELL that hasn't settled = cash inflow not yet credited.
 * Returns the net unsettled amount (positive = cash locked up).
 */
export function computeUnsettledCash(
	trades: ReadonlyArray<UnsettledTrade>,
	now: Date = new Date(),
): number {
	let unsettledBuys = 0;
	let unsettledSells = 0;

	for (const trade of trades) {
		const exchange = trade.exchange as Exchange;
		if (!(exchange in SETTLEMENT_DAYS)) continue;

		const filledDate = new Date(trade.filledAt);
		const settlementDate = getSettlementDate(filledDate, exchange);

		if (now < settlementDate) {
			const tradeValue = trade.fillPrice * trade.quantity;
			if (trade.side === "BUY") {
				unsettledBuys += tradeValue;
			} else {
				unsettledSells += tradeValue;
			}
		}
	}

	// Net: buys lock up cash, sells will release cash but haven't yet
	return unsettledBuys - unsettledSells;
}

/**
 * Calculate available cash for trading after subtracting unsettled amounts.
 * Returns 0 if unsettled cash exceeds total cash (don't go negative).
 */
export function getAvailableCash(
	totalCash: number,
	trades: ReadonlyArray<UnsettledTrade>,
	now: Date = new Date(),
): number {
	const unsettled = computeUnsettledCash(trades, now);
	return Math.max(0, totalCash - unsettled);
}
