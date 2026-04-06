export interface RegimeSignals {
	/** Current ATR as percentile of recent history (0-100). High = volatile. */
	atr_percentile: number;
	/** Fraction of universe symbols with volume_ratio > 1.0 (0-1). High = broad participation. */
	volume_breadth: number;
	/** Momentum regime score (0-1). >0.5 = trending, <0.5 = mean-reverting/choppy. */
	momentum_regime: number;
}

export interface RegimeInput {
	atrHistory: number[];
	currentAtr: number;
	volumeRatios: number[];
	recentReturns: number[];
}

export function calcAtrPercentile(current: number, history: number[]): number {
	if (history.length === 0) return 50;
	const belowCount = history.filter((v) => v < current).length;
	return (belowCount / history.length) * 100;
}

export function calcVolumeBreadth(volumeRatios: number[]): number {
	if (volumeRatios.length === 0) return 0;
	const aboveAvg = volumeRatios.filter((v) => v > 1.0).length;
	return aboveAvg / volumeRatios.length;
}

export function calcMomentumRegime(returns: number[]): number {
	if (returns.length < 2) return 0.5;
	const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
	let numerator = 0;
	let denominator = 0;
	for (let i = 1; i < returns.length; i++) {
		numerator += (returns[i]! - mean) * (returns[i - 1]! - mean);
		denominator += (returns[i]! - mean) ** 2;
	}
	if (denominator === 0) return 0.5;
	const autocorr = numerator / denominator;
	return Math.max(0, Math.min(1, (autocorr + 1) / 2));
}

export function detectRegime(input: RegimeInput): RegimeSignals {
	return {
		atr_percentile: calcAtrPercentile(input.currentAtr, input.atrHistory),
		volume_breadth: calcVolumeBreadth(input.volumeRatios),
		momentum_regime: calcMomentumRegime(input.recentReturns),
	};
}
