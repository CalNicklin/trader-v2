import { describe, expect, test } from "bun:test";

describe("contracts", () => {
	test("lseStock creates GBP SMART-routed contract", async () => {
		const { lseStock } = await import("../../src/broker/contracts.ts");
		const c = lseStock("SHEL");
		expect(c.symbol).toBe("SHEL");
		expect(c.exchange).toBe("SMART");
		expect(c.primaryExch).toBe("LSE");
		expect(c.currency).toBe("GBP");
	});

	test("usStock creates USD SMART-routed contract", async () => {
		const { usStock } = await import("../../src/broker/contracts.ts");
		const c = usStock("AAPL", "NASDAQ");
		expect(c.symbol).toBe("AAPL");
		expect(c.exchange).toBe("SMART");
		expect(c.primaryExch).toBe("NASDAQ");
		expect(c.currency).toBe("USD");
	});

	test("getContract dispatches LSE to lseStock", async () => {
		const { getContract } = await import("../../src/broker/contracts.ts");
		const c = getContract("BARC", "LSE");
		expect(c.currency).toBe("GBP");
		expect(c.primaryExch).toBe("LSE");
	});

	test("getContract dispatches NYSE to usStock", async () => {
		const { getContract } = await import("../../src/broker/contracts.ts");
		const c = getContract("JPM", "NYSE");
		expect(c.currency).toBe("USD");
		expect(c.primaryExch).toBe("NYSE");
	});
});
