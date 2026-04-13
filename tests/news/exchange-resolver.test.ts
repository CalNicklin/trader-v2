import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _resetExchangeResolverCache } from "../../src/data/fmp.ts";
import { parseUniverseSpec } from "../../src/news/exchange-resolver.ts";

describe("parseUniverseSpec", () => {
	beforeEach(() => {
		_resetExchangeResolverCache();
	});

	test("explicit exchange suffix wins (no FMP call)", async () => {
		const resolver = mock(async () => "NASDAQ" as const);
		const result = await parseUniverseSpec("SHEL:LSE", { resolver });
		expect(result).toEqual({ symbol: "SHEL", exchange: "LSE" });
		expect(resolver).not.toHaveBeenCalled();
	});

	test("bare symbol resolved via FMP", async () => {
		const resolver = mock(async () => "NYSE" as const);
		const result = await parseUniverseSpec("JPM", { resolver });
		expect(result).toEqual({ symbol: "JPM", exchange: "NYSE" });
		expect(resolver).toHaveBeenCalledWith("JPM");
	});

	test("returns null when resolver cannot determine exchange", async () => {
		const resolver = mock(async () => null);
		const result = await parseUniverseSpec("FAKE", { resolver });
		expect(result).toBeNull();
	});

	test("malformed spec returns null", async () => {
		const resolver = mock(async () => "NYSE" as const);
		expect(await parseUniverseSpec("", { resolver })).toBeNull();
		expect(await parseUniverseSpec(":NYSE", { resolver })).toBeNull();
	});
});
