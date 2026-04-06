import { describe, expect, test } from "bun:test";
import {
	calcAtrPercentile,
	calcMomentumRegime,
	calcVolumeBreadth,
	detectRegime,
} from "../../src/strategy/regime";

describe("regime detection", () => {
	test("calculates ATR percentile from historical ATR values", () => {
		const atrHistory = [
			1.0, 1.2, 1.5, 1.3, 1.8, 2.0, 1.6, 1.4, 1.7, 1.9, 2.1, 2.3, 1.5, 1.8, 2.0, 1.6, 1.4, 1.7, 1.9,
			2.1,
		];
		const currentAtr = 2.5;
		const percentile = calcAtrPercentile(currentAtr, atrHistory);
		expect(percentile).toBeGreaterThan(90);
	});

	test("calculates volume breadth as fraction of universe with above-avg volume", () => {
		const volumeRatios = [1.5, 0.8, 2.0, 0.5, 1.2]; // 3 of 5 above 1.0
		const breadth = calcVolumeBreadth(volumeRatios);
		expect(breadth).toBeCloseTo(0.6, 1);
	});

	test("detects momentum regime from trending returns", () => {
		const returns = [0.1, 0.2, 0.3, 0.4, 0.5]; // Steadily increasing = trending
		const regime = calcMomentumRegime(returns);
		expect(regime).toBeGreaterThan(0.5);
	});

	test("detects mean-reversion regime from choppy returns", () => {
		const returns = [0.5, -0.3, 0.8, -0.6, 0.2]; // Alternating = choppy
		const regime = calcMomentumRegime(returns);
		expect(regime).toBeLessThan(0.5);
	});

	test("detectRegime returns full signal set", () => {
		const result = detectRegime({
			atrHistory: [1.0, 1.5, 2.0, 1.5, 1.0],
			currentAtr: 1.8,
			volumeRatios: [1.2, 0.8, 1.5],
			recentReturns: [0.5, 0.3, -0.1, 0.4, 0.2],
		});
		expect(result).toHaveProperty("atr_percentile");
		expect(result).toHaveProperty("volume_breadth");
		expect(result).toHaveProperty("momentum_regime");
		expect(result.atr_percentile).toBeGreaterThanOrEqual(0);
		expect(result.atr_percentile).toBeLessThanOrEqual(100);
		expect(result.volume_breadth).toBeGreaterThanOrEqual(0);
		expect(result.volume_breadth).toBeLessThanOrEqual(1);
	});
});
