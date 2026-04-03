export interface Candle {
	date: Date;
	open: number | null;
	high: number | null;
	low: number | null;
	close: number | null;
	volume: number | null;
}

/**
 * RSI (Relative Strength Index) using Wilder's smoothing.
 * Returns null if fewer than period+1 valid closing prices.
 */
export function calcRSI(candles: Candle[], period = 14): number | null {
	const closes: number[] = [];
	for (const c of candles) {
		if (c.close != null) closes.push(c.close);
	}
	if (closes.length < period + 1) return null;

	const changes: number[] = [];
	for (let i = 1; i < closes.length; i++) {
		changes.push(closes[i]! - closes[i - 1]!);
	}

	let avgGain = 0;
	let avgLoss = 0;
	for (let i = 0; i < period; i++) {
		if (changes[i]! > 0) avgGain += changes[i]!;
		else avgLoss += Math.abs(changes[i]!);
	}
	avgGain /= period;
	avgLoss /= period;

	for (let i = period; i < changes.length; i++) {
		const gain = changes[i]! > 0 ? changes[i]! : 0;
		const loss = changes[i]! < 0 ? Math.abs(changes[i]!) : 0;
		avgGain = (avgGain * (period - 1) + gain) / period;
		avgLoss = (avgLoss * (period - 1) + loss) / period;
	}

	if (avgLoss === 0) return 100;
	const rs = avgGain / avgLoss;
	return 100 - 100 / (1 + rs);
}

/**
 * ATR (Average True Range) using Wilder's smoothing.
 * Returns null if fewer than period+1 valid candles.
 */
export function calcATR(candles: Candle[], period = 14): number | null {
	const valid = candles.filter(
		(c): c is Candle & { high: number; low: number; close: number } =>
			c.high != null && c.low != null && c.close != null,
	);
	if (valid.length < period + 1) return null;

	const trueRanges: number[] = [];
	for (let i = 1; i < valid.length; i++) {
		const high = valid[i]!.high;
		const low = valid[i]!.low;
		const prevClose = valid[i - 1]!.close;
		trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
	}

	let atr = 0;
	for (let i = 0; i < period; i++) {
		atr += trueRanges[i]!;
	}
	atr /= period;

	for (let i = period; i < trueRanges.length; i++) {
		atr = (atr * (period - 1) + trueRanges[i]!) / period;
	}

	return atr;
}

/**
 * Volume ratio: latest volume / average volume over prior N days.
 * Returns null if insufficient data or zero average.
 */
export function calcVolumeRatio(candles: Candle[], avgPeriod = 20): number | null {
	const volumes: number[] = [];
	for (const c of candles) {
		if (c.volume != null && c.volume > 0) volumes.push(c.volume);
	}
	if (volumes.length < avgPeriod + 1) return null;

	const currentVolume = volumes[volumes.length - 1]!;
	let sum = 0;
	for (let i = volumes.length - 1 - avgPeriod; i < volumes.length - 1; i++) {
		sum += volumes[i]!;
	}
	const avgVolume = sum / avgPeriod;

	if (avgVolume === 0) return null;
	return currentVolume / avgVolume;
}
