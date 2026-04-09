import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const mockGetMarketDataSnapshot = mock();
const mockApi = { getMarketDataSnapshot: mockGetMarketDataSnapshot };
const mockGetApi = mock(() => mockApi);
const mockIsConnected = mock(() => true);

mock.module("../../src/broker/connection.ts", () => ({
	getApi: mockGetApi,
	isConnected: mockIsConnected,
}));

mock.module("../../src/broker/contracts.ts", () => ({
	getContract: (symbol: string, exchange: string) => ({
		symbol,
		secType: "STK",
		exchange: "SMART",
		primaryExch: exchange,
		currency: exchange === "LSE" ? "GBP" : "USD",
	}),
}));

const { ibkrQuote } = await import("../../src/broker/market-data.ts");

describe("ibkrQuote", () => {
	beforeEach(() => {
		mockIsConnected.mockReturnValue(true);
		mockGetMarketDataSnapshot.mockReset();
	});

	afterEach(() => {
		mock.restore();
	});

	test("returns quote data from IBKR snapshot", async () => {
		const snapshotMap = new Map();
		snapshotMap.set(4, { value: 1330.5 }); // TickType.LAST = 4
		snapshotMap.set(1, { value: 1330.0 }); // TickType.BID = 1
		snapshotMap.set(2, { value: 1331.0 }); // TickType.ASK = 2
		snapshotMap.set(8, { value: 5000000 }); // TickType.VOLUME = 8

		mockGetMarketDataSnapshot.mockResolvedValue(snapshotMap);

		const result = await ibkrQuote("HSBA", "LSE");

		expect(result).not.toBeNull();
		expect(result!.symbol).toBe("HSBA");
		expect(result!.exchange).toBe("LSE");
		expect(result!.last).toBe(1330.5);
		expect(result!.bid).toBe(1330.0);
		expect(result!.ask).toBe(1331.0);
		expect(result!.volume).toBe(5000000);
	});

	test("returns null when IBKR is disconnected", async () => {
		mockIsConnected.mockReturnValue(false);
		const result = await ibkrQuote("HSBA", "LSE");
		expect(result).toBeNull();
	});

	test("returns null when snapshot throws", async () => {
		mockGetMarketDataSnapshot.mockRejectedValue(new Error("timeout"));
		const result = await ibkrQuote("HSBA", "LSE");
		expect(result).toBeNull();
	});

	test("returns quote with null fields when ticks are missing", async () => {
		const snapshotMap = new Map();
		snapshotMap.set(4, { value: 1330.5 });
		mockGetMarketDataSnapshot.mockResolvedValue(snapshotMap);

		const result = await ibkrQuote("HSBA", "LSE");
		expect(result).not.toBeNull();
		expect(result!.last).toBe(1330.5);
		expect(result!.bid).toBeNull();
		expect(result!.ask).toBeNull();
		expect(result!.volume).toBeNull();
	});
});
