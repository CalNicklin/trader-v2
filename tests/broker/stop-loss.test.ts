import { describe, expect, test } from "bun:test";

describe("stop-loss", () => {
	test("findStopLossBreaches detects breach when price <= stop", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: 145, bid: 144 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(1);
		expect(breaches[0]!.symbol).toBe("AAPL");
		expect(breaches[0]!.price).toBe(145);
	});

	test("findStopLossBreaches no breach when price > stop", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: 155, bid: 154 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(0);
	});

	test("findStopLossBreaches skips positions without stop-loss", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: null },
		];
		const quotes = new Map([["AAPL", { last: 100, bid: 99 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(0);
	});

	test("findStopLossBreaches skips zero-quantity positions", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 0, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: 100, bid: 99 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(0);
	});

	test("findStopLossBreaches uses bid when last is null", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: null, bid: 140 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(1);
		expect(breaches[0]!.price).toBe(140);
	});

	test("findStopLossBreaches skips when no quote available", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map<string, { last: number | null; bid: number | null }>();
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(0);
	});

	test("findStopLossBreaches breach at exact stop price", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: 150, bid: 149 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(1);
	});
});
