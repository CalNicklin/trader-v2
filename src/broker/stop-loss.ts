export interface StopLossPosition {
	id: number;
	symbol: string;
	quantity: number;
	stopLossPrice: number | null;
}

export interface StopLossBreach {
	symbol: string;
	quantity: number;
	price: number;
	stopLossPrice: number;
}

export interface QuoteLike {
	last: number | null;
	bid: number | null;
}

/** Pure decision: which positions have breached their stop-loss? */
export function findStopLossBreaches(
	positions: ReadonlyArray<StopLossPosition>,
	quotes: Map<string, QuoteLike>,
): StopLossBreach[] {
	const breaches: StopLossBreach[] = [];
	for (const pos of positions) {
		if (!pos.stopLossPrice || pos.quantity <= 0) continue;
		const quote = quotes.get(pos.symbol);
		const price = quote?.last ?? quote?.bid ?? null;
		if (price === null) continue;
		if (price <= pos.stopLossPrice) {
			breaches.push({
				symbol: pos.symbol,
				quantity: pos.quantity,
				price,
				stopLossPrice: pos.stopLossPrice,
			});
		}
	}
	return breaches;
}
