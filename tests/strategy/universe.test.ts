import { beforeEach, describe, expect, test } from "bun:test";

describe("universe management", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		const { _clearInjections } = await import("../../src/strategy/universe.ts");
		_clearInjections();
	});

	test("UNIVERSE_CAP is 50", async () => {
		const { UNIVERSE_CAP } = await import("../../src/strategy/universe.ts");
		expect(UNIVERSE_CAP).toBe(50);
	});

	test("MIN_AVG_VOLUME is 500000", async () => {
		const { MIN_AVG_VOLUME } = await import("../../src/strategy/universe.ts");
		expect(MIN_AVG_VOLUME).toBe(500_000);
	});

	test("validateUniverse caps at 50 symbols", async () => {
		const { validateUniverse, UNIVERSE_CAP } = await import("../../src/strategy/universe.ts");
		const symbols = Array.from({ length: 60 }, (_, i) => `SYM${i}`);
		const result = validateUniverse(symbols);
		expect(result).toHaveLength(UNIVERSE_CAP);
		expect(result[0]).toBe("SYM0");
		expect(result[49]).toBe("SYM49");
	});

	test("validateUniverse deduplicates symbols", async () => {
		const { validateUniverse } = await import("../../src/strategy/universe.ts");
		const result = validateUniverse(["AAPL", "MSFT", "AAPL", "GOOGL", "MSFT"]);
		expect(result).toHaveLength(3);
		expect(result).toEqual(["AAPL", "MSFT", "GOOGL"]);
	});

	test("validateUniverse dedupes bare symbol and SYM:NASDAQ as the same entry", async () => {
		// Regression for TRA-36: base universe "AMD" + injected "AMD:NASDAQ" must
		// collapse to one entry so the evaluator doesn't process the same
		// (symbol, exchange) pair twice and open duplicate positions in a tick.
		const { validateUniverse } = await import("../../src/strategy/universe.ts");
		const result = validateUniverse(["AMD", "TSLA", "AMD:NASDAQ", "TSLA:NASDAQ"]);
		expect(result).toHaveLength(2);
		expect(result).toEqual(["AMD", "TSLA"]);
	});

	test("validateUniverse keeps explicit exchange qualifier when it comes first", async () => {
		const { validateUniverse } = await import("../../src/strategy/universe.ts");
		const result = validateUniverse(["AMD:NASDAQ", "AMD"]);
		expect(result).toEqual(["AMD:NASDAQ"]);
	});

	test("validateUniverse keeps cross-exchange listings as distinct entries", async () => {
		// e.g. BP dual-listing — NYSE and LSE are separate (symbol, exchange) pairs.
		const { validateUniverse } = await import("../../src/strategy/universe.ts");
		const result = validateUniverse(["BP:NYSE", "BP:LSE"]);
		expect(result).toHaveLength(2);
		expect(result).toEqual(["BP:NYSE", "BP:LSE"]);
	});

	test("buildEffectiveUniverse does not double-count base symbol already matched by injection", async () => {
		// Regression for TRA-36: if a strategy's base universe already contains
		// a bare "AMD", a subsequent injectSymbol("AMD","NASDAQ") must not add
		// a second "AMD:NASDAQ" entry.
		const { buildEffectiveUniverse, injectSymbol, _clearInjections } = await import(
			"../../src/strategy/universe.ts"
		);
		_clearInjections();
		injectSymbol("AMD", "NASDAQ", 60_000);
		const result = await buildEffectiveUniverse(["AMD", "MSFT"]);
		const amdLike = result.filter((s) => s === "AMD" || s === "AMD:NASDAQ");
		expect(amdLike).toHaveLength(1);
	});

	test("filterByLiquidity removes symbols below avg volume threshold", async () => {
		const { filterByLiquidity } = await import("../../src/strategy/universe.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await db.insert(quotesCache).values([
			{ symbol: "AAPL", exchange: "NASDAQ", avgVolume: 1_000_000 },
			{ symbol: "TINY", exchange: "NASDAQ", avgVolume: 100_000 },
			{ symbol: "MSFT", exchange: "NASDAQ", avgVolume: 800_000 },
			{ symbol: "MICRO", exchange: "AIM", avgVolume: 50_000 },
		]);

		const result = await filterByLiquidity(["AAPL", "TINY", "MSFT", "MICRO"], "NASDAQ");
		expect(result).toContain("AAPL");
		expect(result).toContain("MSFT");
		expect(result).not.toContain("TINY");
		expect(result).not.toContain("MICRO");
	});

	test("filterByLiquidity keeps symbols with no quote data", async () => {
		const { filterByLiquidity } = await import("../../src/strategy/universe.ts");
		const result = await filterByLiquidity(["UNKNOWN"], "NASDAQ");
		expect(result).toContain("UNKNOWN");
	});

	test("getInjectedSymbols returns empty when no high-urgency events", async () => {
		const { getInjectedSymbols } = await import("../../src/strategy/universe.ts");
		const result = await getInjectedSymbols();
		expect(result).toHaveLength(0);
	});

	test("injectSymbol adds a symbol with TTL", async () => {
		const { injectSymbol, getInjectedSymbols } = await import("../../src/strategy/universe.ts");
		injectSymbol("BREAKING", "NASDAQ", 60_000);
		const result = await getInjectedSymbols();
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ symbol: "BREAKING", exchange: "NASDAQ" });
	});

	test("injectSymbol expires after TTL", async () => {
		const { injectSymbol, getInjectedSymbols, _expireInjections, _clearInjections } = await import(
			"../../src/strategy/universe.ts"
		);
		_clearInjections();
		injectSymbol("OLD", "NASDAQ", 0);
		_expireInjections();
		const result = await getInjectedSymbols();
		expect(result).toHaveLength(0);
	});

	test("buildEffectiveUniverse merges with injected symbols", async () => {
		const { buildEffectiveUniverse, injectSymbol, _clearInjections } = await import(
			"../../src/strategy/universe.ts"
		);
		_clearInjections();
		injectSymbol("BREAKING", "NYSE", 60_000);
		const base = ["AAPL", "MSFT", "GOOGL"];
		const result = await buildEffectiveUniverse(base);
		expect(result).toContain("AAPL");
		expect(result).toContain("MSFT");
		expect(result).toContain("GOOGL");
		expect(result).toContain("BREAKING:NYSE");
	});
});
