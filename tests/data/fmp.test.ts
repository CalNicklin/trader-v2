import { afterEach, describe, expect, test } from "bun:test";
import { _clearValidationCache, _resetRateLimiter, toFmpSymbol } from "../../src/data/fmp.ts";

afterEach(() => {
	_clearValidationCache();
	_resetRateLimiter();
});

describe("toFmpSymbol", () => {
	test("LSE symbols get .L suffix", () => {
		expect(toFmpSymbol("BARC", "LSE")).toBe("BARC.L");
	});

	test("AIM symbols get .L suffix", () => {
		expect(toFmpSymbol("FDEV", "AIM")).toBe("FDEV.L");
	});

	test("NASDAQ symbols are bare", () => {
		expect(toFmpSymbol("AAPL", "NASDAQ")).toBe("AAPL");
	});

	test("NYSE symbols are bare", () => {
		expect(toFmpSymbol("JPM", "NYSE")).toBe("JPM");
	});

	test("unknown exchange returns bare symbol", () => {
		expect(toFmpSymbol("XYZ", "OTHER")).toBe("XYZ");
	});
});

describe("validation cache", () => {
	test("_clearValidationCache resets the cache", async () => {
		// We can't easily test the cache without mocking fetch,
		// but we can verify the function doesn't throw
		_clearValidationCache();
	});

	test("_resetRateLimiter resets without error", () => {
		_resetRateLimiter();
	});
});

describe("rate limiter", () => {
	test("_resetRateLimiter clears request timestamps", () => {
		// After reset, rate limiter should be fresh
		_resetRateLimiter();
		// No assertion needed — just verifying it doesn't throw
	});
});
