export interface TrailingStopPosition {
	id: number;
	symbol: string;
	quantity: number;
	highWaterMark: number | null;
	trailingStopPrice: number | null;
	atr14: number | null;
	currentPrice: number | null;
}

export interface TrailingStopUpdate {
	positionId: number;
	symbol: string;
	highWaterMark: number;
	trailingStopPrice: number;
	triggered: boolean;
}

export function computeTrailingStopUpdate(
	pos: TrailingStopPosition,
	atrMultiplier: number,
): TrailingStopUpdate | null {
	if (!pos.highWaterMark || !pos.atr14 || pos.currentPrice === null) return null;

	const newHighWater = Math.max(pos.highWaterMark, pos.currentPrice);
	const recalculatedStop = newHighWater - pos.atr14 * atrMultiplier;
	const effectiveStop = Math.max(recalculatedStop, pos.trailingStopPrice ?? 0);

	return {
		positionId: pos.id,
		symbol: pos.symbol,
		highWaterMark: newHighWater,
		trailingStopPrice: effectiveStop,
		triggered: pos.currentPrice <= effectiveStop && pos.currentPrice > 0,
	};
}
