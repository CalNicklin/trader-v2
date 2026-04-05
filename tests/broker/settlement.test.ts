import { describe, expect, test } from "bun:test";

describe("settlement", () => {
	test("getSettlementDate T+1 for US stock (weekday)", async () => {
		const { getSettlementDate } = await import("../../src/broker/settlement.ts");
		// Wednesday 2026-04-01 -> T+1 = Thursday 2026-04-02
		const tradeDate = new Date("2026-04-01T15:00:00Z");
		const settlement = getSettlementDate(tradeDate, "NASDAQ");
		expect(settlement.toISOString().slice(0, 10)).toBe("2026-04-02");
	});

	test("getSettlementDate T+2 for LSE stock (weekday)", async () => {
		const { getSettlementDate } = await import("../../src/broker/settlement.ts");
		// Wednesday 2026-04-01 -> T+2 = Friday 2026-04-03
		const tradeDate = new Date("2026-04-01T15:00:00Z");
		const settlement = getSettlementDate(tradeDate, "LSE");
		expect(settlement.toISOString().slice(0, 10)).toBe("2026-04-03");
	});

	test("getSettlementDate skips weekends for US T+1", async () => {
		const { getSettlementDate } = await import("../../src/broker/settlement.ts");
		// Friday 2026-04-03 -> T+1 skips Sat/Sun = Monday 2026-04-06
		const tradeDate = new Date("2026-04-03T15:00:00Z");
		const settlement = getSettlementDate(tradeDate, "NYSE");
		expect(settlement.toISOString().slice(0, 10)).toBe("2026-04-06");
	});

	test("getSettlementDate skips weekends for LSE T+2", async () => {
		const { getSettlementDate } = await import("../../src/broker/settlement.ts");
		// Thursday 2026-04-02 -> T+2 = Fri(+1), skip Sat/Sun, Mon(+2) = 2026-04-06
		const tradeDate = new Date("2026-04-02T15:00:00Z");
		const settlement = getSettlementDate(tradeDate, "LSE");
		expect(settlement.toISOString().slice(0, 10)).toBe("2026-04-06");
	});

	test("computeUnsettledCash counts unsettled buys as locked cash", async () => {
		const { computeUnsettledCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-02T12:00:00Z"); // Thursday
		const trades = [
			{
				fillPrice: 100,
				quantity: 10,
				side: "BUY" as const,
				exchange: "NASDAQ",
				filledAt: "2026-04-02T10:00:00Z", // Same day — settles 2026-04-03
			},
		];
		const unsettled = computeUnsettledCash(trades, now);
		expect(unsettled).toBe(1000); // 100 * 10 locked
	});

	test("computeUnsettledCash returns 0 for settled trades", async () => {
		const { computeUnsettledCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-04T12:00:00Z"); // Saturday
		const trades = [
			{
				fillPrice: 100,
				quantity: 10,
				side: "BUY" as const,
				exchange: "NASDAQ",
				filledAt: "2026-04-02T10:00:00Z", // Settled on 2026-04-03
			},
		];
		const unsettled = computeUnsettledCash(trades, now);
		expect(unsettled).toBe(0);
	});

	test("computeUnsettledCash nets buys against sells", async () => {
		const { computeUnsettledCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-02T12:00:00Z");
		const trades = [
			{
				fillPrice: 100,
				quantity: 10,
				side: "BUY" as const,
				exchange: "NASDAQ",
				filledAt: "2026-04-02T10:00:00Z",
			},
			{
				fillPrice: 50,
				quantity: 10,
				side: "SELL" as const,
				exchange: "NASDAQ",
				filledAt: "2026-04-02T10:00:00Z",
			},
		];
		const unsettled = computeUnsettledCash(trades, now);
		expect(unsettled).toBe(500); // 1000 - 500
	});

	test("getAvailableCash subtracts unsettled from total", async () => {
		const { getAvailableCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-02T12:00:00Z");
		const trades = [
			{
				fillPrice: 100,
				quantity: 10,
				side: "BUY" as const,
				exchange: "NASDAQ",
				filledAt: "2026-04-02T10:00:00Z",
			},
		];
		const available = getAvailableCash(5000, trades, now);
		expect(available).toBe(4000); // 5000 - 1000
	});

	test("getAvailableCash never goes below 0", async () => {
		const { getAvailableCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-02T12:00:00Z");
		const trades = [
			{
				fillPrice: 100,
				quantity: 100,
				side: "BUY" as const,
				exchange: "NASDAQ",
				filledAt: "2026-04-02T10:00:00Z",
			},
		];
		const available = getAvailableCash(500, trades, now);
		expect(available).toBe(0); // 500 - 10000 clamped to 0
	});
});
