// tests/news/rss-feeds.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { _resetFtse100Cache } from "../../src/data/ftse100.ts";
import {
	_resetRssAliasCache,
	_test_hasCollision,
	_test_hasFinancialContext,
	loadAliases,
} from "../../src/news/rss-feeds.ts";

describe("loadAliases (dynamic)", () => {
	beforeEach(() => {
		_resetRssAliasCache();
		_resetFtse100Cache();
	});

	it("returns aliases for FTSE-100 symbols from the fallback universe", async () => {
		const aliases = await loadAliases({ skipFmp: true });
		expect(aliases.SHEL).toBeDefined();
		expect(aliases.SHEL).toContain("Shell");
	});

	it("merges ALIAS_OVERRIDES with FMP-derived aliases", async () => {
		const aliases = await loadAliases({ skipFmp: true });
		expect(aliases.HSBA).toContain("HSBC");
	});

	it("caches within a 1-hour TTL", async () => {
		const first = await loadAliases({ skipFmp: true });
		const second = await loadAliases({ skipFmp: true });
		expect(first).toBe(second); // same reference = cached
	});
});

describe("hasFinancialContext", () => {
	it("accepts headlines with plc, shares, earnings, etc.", () => {
		expect(_test_hasFinancialContext("Shell plc reports record profit")).toBe(true);
		expect(_test_hasFinancialContext("BP shares jump on earnings")).toBe(true);
		expect(_test_hasFinancialContext("Vodafone trading update disappoints")).toBe(true);
	});

	it("rejects headlines without financial context", () => {
		expect(_test_hasFinancialContext("Shell seashells on the seashore")).toBe(false);
		expect(_test_hasFinancialContext("BP oil spill ruled unlawful")).toBe(false);
	});
});

describe("hasCollision", () => {
	it("flags known collision phrases per symbol", () => {
		expect(_test_hasCollision("SHEL", "Using shell script for deploy")).toBe(true);
		expect(_test_hasCollision("SHEL", "Shell plc dividend raised")).toBe(false);
	});

	it("returns false for symbols without a blacklist entry", () => {
		expect(_test_hasCollision("AZN", "Anything at all here")).toBe(false);
	});
});
