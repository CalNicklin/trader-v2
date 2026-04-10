import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const mockGetMarketDataSnapshot = mock();
const mockGetHistoricalData = mock();
const mockSetMarketDataType = mock();
const mockApi = {
	getMarketDataSnapshot: mockGetMarketDataSnapshot,
	getHistoricalData: mockGetHistoricalData,
	setMarketDataType: mockSetMarketDataType,
};
const mockGetApi = mock(() => mockApi);
const mockIsConnected = mock(() => true);

mock.module("../../src/broker/connection.ts", () => ({
	getApi: mockGetApi,
	isConnected: mockIsConnected,
}));

const { ibkrQuote, ibkrHistorical } = await import("../../src/broker/market-data.ts");

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

	test("falls back to delayed ticks when real-time unavailable", async () => {
		const snapshotMap = new Map();
		snapshotMap.set(68, { value: 1330.5 }); // DELAYED_LAST = 68
		snapshotMap.set(66, { value: 1330.0 }); // DELAYED_BID = 66
		snapshotMap.set(67, { value: 1331.0 }); // DELAYED_ASK = 67
		snapshotMap.set(74, { value: 5000000 }); // DELAYED_VOLUME = 74
		mockGetMarketDataSnapshot.mockResolvedValue(snapshotMap);

		const result = await ibkrQuote("HSBA", "LSE");

		expect(result).not.toBeNull();
		expect(result!.last).toBe(1330.5);
		expect(result!.bid).toBe(1330.0);
		expect(result!.ask).toBe(1331.0);
		expect(result!.volume).toBe(5000000);
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

describe("ibkrHistorical", () => {
	beforeEach(() => {
		mockIsConnected.mockReturnValue(true);
		mockGetHistoricalData.mockReset();
	});

	afterEach(() => {
		mock.restore();
	});

	test("returns bars in oldest-first order", async () => {
		mockGetHistoricalData.mockResolvedValue([
			{ time: "20260401", open: 100, high: 110, low: 95, close: 105, volume: 1000 },
			{ time: "20260402", open: 105, high: 115, low: 100, close: 112, volume: 2000 },
			{ time: "20260403", open: 112, high: 120, low: 108, close: 118, volume: 1500 },
		]);

		const result = await ibkrHistorical("HSBA", "LSE");

		expect(result).not.toBeNull();
		const bars = result!;
		expect(bars.length).toBe(3);
		expect(bars[0]!.date).toBe("2026-04-01");
		expect(bars[0]!.open).toBe(100);
		expect(bars[0]!.high).toBe(110);
		expect(bars[0]!.low).toBe(95);
		expect(bars[0]!.close).toBe(105);
		expect(bars[0]!.volume).toBe(1000);
		expect(bars[1]!.date).toBe("2026-04-02");
		expect(bars[2]!.date).toBe("2026-04-03");
	});

	test("returns null when IBKR is disconnected", async () => {
		mockIsConnected.mockReturnValue(false);
		const result = await ibkrHistorical("HSBA", "LSE");
		expect(result).toBeNull();
	});

	test("returns null when getHistoricalData throws", async () => {
		mockGetHistoricalData.mockRejectedValue(new Error("IBKR error"));
		const result = await ibkrHistorical("HSBA", "LSE");
		expect(result).toBeNull();
	});

	test("returns null for empty bar array", async () => {
		mockGetHistoricalData.mockResolvedValue([]);
		const result = await ibkrHistorical("HSBA", "LSE");
		expect(result).toBeNull();
	});

	test("defaults to 90 days when days not specified", async () => {
		mockGetHistoricalData.mockResolvedValue([
			{ time: "20260401", open: 100, high: 110, low: 95, close: 105, volume: 1000 },
		]);

		await ibkrHistorical("HSBA", "LSE");

		expect(mockGetHistoricalData).toHaveBeenCalledWith(
			expect.anything(),
			"",
			"90 D",
			expect.anything(),
			"TRADES",
			1,
			1,
		);
	});
});
