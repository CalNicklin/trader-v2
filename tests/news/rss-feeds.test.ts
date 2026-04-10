// tests/news/rss-feeds.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { _resetFtse100Cache } from "../../src/data/ftse100.ts";
import { _resetRssAliasCache, loadAliases } from "../../src/news/rss-feeds.ts";

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
