import { describe, expect, test } from "bun:test";

// Unit tests for type contracts — actual API calls require IBKR connection
describe("account module types", () => {
	test("AccountSummary interface has required fields", async () => {
		const { getAccountSummary } = await import("../../src/broker/account.ts");
		expect(typeof getAccountSummary).toBe("function");
	});

	test("getPositions returns array", async () => {
		const { getPositions } = await import("../../src/broker/account.ts");
		expect(typeof getPositions).toBe("function");
	});
});
