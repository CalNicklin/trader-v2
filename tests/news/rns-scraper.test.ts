// tests/news/rns-scraper.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import {
	_getRnsCircuitState,
	_resetRnsCircuitBreaker,
	fetchRnsNews,
} from "../../src/news/rns-scraper.ts";

describe("RNS scraper", () => {
	beforeEach(() => {
		_resetRnsCircuitBreaker();
	});

	it("respects the RNS_SCRAPER_ENABLED flag", async () => {
		process.env.RNS_SCRAPER_ENABLED = "false";
		const items = await fetchRnsNews(["SHEL"]);
		expect(items).toEqual([]);
		delete process.env.RNS_SCRAPER_ENABLED;
	});

	it("opens the circuit after 3 consecutive failures", async () => {
		// Use a fetch mock that returns 403
		const origFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
		try {
			await fetchRnsNews(["SHEL", "BP.", "HSBA"]);
			expect(_getRnsCircuitState()).toBe("open");
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});
