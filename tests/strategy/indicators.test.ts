import { describe, expect, test } from "bun:test";
import { type Candle, calcATR, calcRSI, calcVolumeRatio } from "../../src/strategy/indicators.ts";

function makeCandles(closes: number[], volumes?: number[]): Candle[] {
	return closes.map((close, i) => ({
		date: new Date(2026, 0, i + 1),
		open: close - 0.5,
		high: close + 1,
		low: close - 1,
		close,
		volume: volumes?.[i] ?? 1000000,
	}));
}

describe("calcRSI", () => {
	test("returns null with insufficient data", () => {
		const candles = makeCandles([100, 101, 102]);
		expect(calcRSI(candles, 14)).toBeNull();
	});

	test("returns 100 when all gains (no losses)", () => {
		const closes = Array.from({ length: 16 }, (_, i) => 100 + i);
		const candles = makeCandles(closes);
		expect(calcRSI(candles, 14)).toBe(100);
	});

	test("returns value between 0 and 100 for mixed data", () => {
		const closes = [
			100, 102, 101, 103, 104, 102, 105, 103, 106, 104, 107, 105, 108, 106, 109, 107, 110, 108, 111,
			109, 112, 110, 113, 111, 114, 112, 115, 113, 116, 114,
		];
		const candles = makeCandles(closes);
		const rsi = calcRSI(candles, 14);
		expect(rsi).not.toBeNull();
		expect(rsi!).toBeGreaterThan(0);
		expect(rsi!).toBeLessThan(100);
	});

	test("RSI is low when price mostly falls", () => {
		const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 2 + (i % 3 === 0 ? 1 : 0));
		const candles = makeCandles(closes);
		const rsi = calcRSI(candles, 14);
		expect(rsi).not.toBeNull();
		expect(rsi!).toBeLessThan(40);
	});
});

describe("calcATR", () => {
	test("returns null with insufficient data", () => {
		const candles = makeCandles([100, 101, 102]);
		expect(calcATR(candles, 14)).toBeNull();
	});

	test("returns positive value for valid data", () => {
		const closes = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 5);
		const candles = closes.map((close, i) => ({
			date: new Date(2026, 0, i + 1),
			open: close - 0.3,
			high: close + 2,
			low: close - 2,
			close,
			volume: 1000000,
		}));
		const atr = calcATR(candles, 14);
		expect(atr).not.toBeNull();
		expect(atr!).toBeGreaterThan(0);
	});

	test("ATR is larger when candles have wider range", () => {
		const makeRangedCandles = (range: number): Candle[] =>
			Array.from({ length: 20 }, (_, i) => ({
				date: new Date(2026, 0, i + 1),
				open: 100,
				high: 100 + range,
				low: 100 - range,
				close: 100,
				volume: 1000000,
			}));

		const narrowATR = calcATR(makeRangedCandles(1), 14);
		const wideATR = calcATR(makeRangedCandles(5), 14);
		expect(narrowATR).not.toBeNull();
		expect(wideATR).not.toBeNull();
		expect(wideATR!).toBeGreaterThan(narrowATR!);
	});
});

describe("calcVolumeRatio", () => {
	test("returns null with insufficient data", () => {
		const candles = makeCandles([100, 101], [500, 600]);
		expect(calcVolumeRatio(candles, 20)).toBeNull();
	});

	test("returns ~1.0 when volume is constant", () => {
		const closes = Array.from({ length: 25 }, () => 100);
		const volumes = Array.from({ length: 25 }, () => 1000000);
		const candles = makeCandles(closes, volumes);
		const ratio = calcVolumeRatio(candles, 20);
		expect(ratio).not.toBeNull();
		expect(ratio!).toBeCloseTo(1.0, 2);
	});

	test("returns > 1 when latest volume is above average", () => {
		const closes = Array.from({ length: 25 }, () => 100);
		const volumes = Array.from({ length: 25 }, () => 1000000);
		volumes[24] = 3000000;
		const candles = makeCandles(closes, volumes);
		const ratio = calcVolumeRatio(candles, 20);
		expect(ratio).not.toBeNull();
		expect(ratio!).toBeGreaterThan(2.5);
	});
});
