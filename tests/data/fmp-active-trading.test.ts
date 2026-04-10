import { afterEach, describe, expect, it } from "bun:test";
import { _resetValidationCache, fmpValidateSymbol } from "../../src/data/fmp.ts";

describe("fmpValidateSymbol isActivelyTrading", () => {
	const origFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = origFetch;
		_resetValidationCache();
	});

	it("rejects symbols with isActivelyTrading=false", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify([
					{
						symbol: "RDSB.L",
						companyName: "Shell",
						exchange: "LSE",
						isActivelyTrading: false,
					},
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;
		_resetValidationCache();
		const result = await fmpValidateSymbol("RDSB", "LSE");
		expect(result).toBe(false);
	});

	it("accepts symbols with isActivelyTrading=true", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify([
					{
						symbol: "SHEL.L",
						companyName: "Shell",
						exchange: "LSE",
						isActivelyTrading: true,
					},
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;
		_resetValidationCache();
		const result = await fmpValidateSymbol("SHEL", "LSE");
		expect(result).toBe(true);
	});

	it("accepts symbols without isActivelyTrading field (backwards compat)", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify([{ symbol: "SHEL.L", companyName: "Shell", exchange: "LSE" }]), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		_resetValidationCache();
		const result = await fmpValidateSymbol("SHEL", "LSE");
		expect(result).toBe(true);
	});
});
