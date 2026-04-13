import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	_resetExchangeResolverCache,
	fmpResolveExchange,
	normalizeFmpExchange,
} from "../../src/data/fmp.ts";

describe("normalizeFmpExchange", () => {
	test("maps NASDAQ variants", () => {
		expect(normalizeFmpExchange("NASDAQ Global Select")).toBe("NASDAQ");
		expect(normalizeFmpExchange("NASDAQ Global Market")).toBe("NASDAQ");
		expect(normalizeFmpExchange("NASDAQ Capital Market")).toBe("NASDAQ");
	});
	test("maps NYSE variants", () => {
		expect(normalizeFmpExchange("New York Stock Exchange")).toBe("NYSE");
		expect(normalizeFmpExchange("NYSE American")).toBe("NYSE");
		expect(normalizeFmpExchange("NYSE Arca")).toBe("NYSE");
	});
	test("maps LSE", () => {
		expect(normalizeFmpExchange("London Stock Exchange")).toBe("LSE");
	});
	test("maps short codes", () => {
		expect(normalizeFmpExchange("NMS")).toBe("NASDAQ");
		expect(normalizeFmpExchange("NYQ")).toBe("NYSE");
		expect(normalizeFmpExchange("AIM")).toBe("LSE");
	});
	test("returns null for unrecognized exchange", () => {
		expect(normalizeFmpExchange("Tokyo Stock Exchange")).toBeNull();
		expect(normalizeFmpExchange("")).toBeNull();
	});
});

describe("fmpResolveExchange", () => {
	beforeEach(() => {
		_resetExchangeResolverCache();
	});

	test("returns canonical exchange for a symbol", async () => {
		const fetchMock = mock(async () => [
			{ symbol: "JPM", exchange: "New York Stock Exchange", isActivelyTrading: true },
		]);
		const result = await fmpResolveExchange("JPM", { fetch: fetchMock });
		expect(result).toBe("NYSE");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("caches the result across calls", async () => {
		const fetchMock = mock(async () => [
			{ symbol: "AAPL", exchange: "NASDAQ Global Select", isActivelyTrading: true },
		]);
		await fmpResolveExchange("AAPL", { fetch: fetchMock });
		await fmpResolveExchange("AAPL", { fetch: fetchMock });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("normalizes cache key across symbol casing", async () => {
		const fetchMock = mock(async () => [
			{ symbol: "AAPL", exchange: "NASDAQ Global Select", isActivelyTrading: true },
		]);
		await fmpResolveExchange("aapl", { fetch: fetchMock });
		await fmpResolveExchange("AAPL", { fetch: fetchMock });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("returns null when FMP returns empty", async () => {
		const fetchMock = mock(async () => []);
		const result = await fmpResolveExchange("XYZNOTREAL", { fetch: fetchMock });
		expect(result).toBeNull();
	});

	test("returns null when exchange string is unrecognized", async () => {
		const fetchMock = mock(async () => [
			{ symbol: "7203.T", exchange: "Tokyo Stock Exchange", isActivelyTrading: true },
		]);
		const result = await fmpResolveExchange("7203.T", { fetch: fetchMock });
		expect(result).toBeNull();
	});

	test("fail-closed on network error", async () => {
		const fetchMock = mock(async () => {
			throw new Error("ECONNRESET");
		});
		const result = await fmpResolveExchange("JPM", { fetch: fetchMock });
		expect(result).toBeNull();
	});
});
