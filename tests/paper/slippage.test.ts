import { describe, expect, test } from "bun:test";

describe("paper slippage haircut", () => {
	test("applyEntrySlippage marks BUY fills up (pays more)", async () => {
		const { applyEntrySlippage } = await import("../../src/paper/slippage.ts");
		// 5 bps haircut on a $100 fill ⇒ 100 * 1.0005 = 100.05
		expect(applyEntrySlippage(100, "BUY", 5)).toBeCloseTo(100.05, 6);
	});

	test("applyEntrySlippage marks SELL fills down (receives less)", async () => {
		const { applyEntrySlippage } = await import("../../src/paper/slippage.ts");
		expect(applyEntrySlippage(100, "SELL", 5)).toBeCloseTo(99.95, 6);
	});

	test("applyExitSlippage: closing a long (exit SELL) receives less", async () => {
		const { applyExitSlippage } = await import("../../src/paper/slippage.ts");
		expect(applyExitSlippage(100, "SELL", 5)).toBeCloseTo(99.95, 6);
	});

	test("applyExitSlippage: closing a short (exit BUY) pays more", async () => {
		const { applyExitSlippage } = await import("../../src/paper/slippage.ts");
		expect(applyExitSlippage(100, "BUY", 5)).toBeCloseTo(100.05, 6);
	});

	test("zero bps is a no-op", async () => {
		const { applyEntrySlippage, applyExitSlippage } = await import("../../src/paper/slippage.ts");
		expect(applyEntrySlippage(123.45, "BUY", 0)).toBe(123.45);
		expect(applyExitSlippage(123.45, "SELL", 0)).toBe(123.45);
	});

	test("getPaperSlippageBps reads PAPER_SLIPPAGE_BPS from config", async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		const originalEnv = process.env.PAPER_SLIPPAGE_BPS;
		try {
			process.env.PAPER_SLIPPAGE_BPS = "7";
			resetConfigForTesting();
			const { getPaperSlippageBps } = await import("../../src/paper/slippage.ts");
			expect(getPaperSlippageBps()).toBe(7);
		} finally {
			if (originalEnv === undefined) delete process.env.PAPER_SLIPPAGE_BPS;
			else process.env.PAPER_SLIPPAGE_BPS = originalEnv;
			resetConfigForTesting();
		}
	});

	test("default slippage is 5 bps when env unset", async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		const originalEnv = process.env.PAPER_SLIPPAGE_BPS;
		try {
			delete process.env.PAPER_SLIPPAGE_BPS;
			resetConfigForTesting();
			const { getPaperSlippageBps } = await import("../../src/paper/slippage.ts");
			expect(getPaperSlippageBps()).toBe(5);
		} finally {
			if (originalEnv !== undefined) process.env.PAPER_SLIPPAGE_BPS = originalEnv;
			resetConfigForTesting();
		}
	});
});
