import { beforeEach, describe, expect, it } from "bun:test";
import { _resetFtse100Cache, getFtse100Universe } from "../../src/data/ftse100.ts";

describe("getFtse100Universe", () => {
	beforeEach(() => {
		_resetFtse100Cache();
	});

	it("returns at least 90 FTSE-100 constituents from the fallback file", async () => {
		const constituents = await getFtse100Universe({ skipFmp: true });
		expect(constituents.length).toBeGreaterThanOrEqual(90);
	});

	it("each constituent has symbol, exchange=LSE, companyName, aliases", async () => {
		const constituents = await getFtse100Universe({ skipFmp: true });
		for (const c of constituents) {
			expect(typeof c.symbol).toBe("string");
			expect(c.symbol.length).toBeGreaterThan(0);
			expect(c.exchange).toBe("LSE");
			expect(typeof c.companyName).toBe("string");
			expect(Array.isArray(c.aliases)).toBe(true);
			expect(c.aliases.length).toBeGreaterThan(0);
		}
	});

	it("normalises FMP .L suffix to bare symbol", async () => {
		const constituents = await getFtse100Universe({ skipFmp: true });
		for (const c of constituents) {
			expect(c.symbol.endsWith(".L")).toBe(false);
		}
	});
});
