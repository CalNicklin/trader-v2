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
		const { injectSymbol, getInjectedSymbols, _expireInjections, _clearInjections } = await import("../../src/strategy/universe.ts");
		_clearInjections();
		injectSymbol("OLD", "NASDAQ", 0);
		_expireInjections();
		const result = await getInjectedSymbols();
		expect(result).toHaveLength(0);
	});

	test("buildEffectiveUniverse merges with injected symbols", async () => {
		const { buildEffectiveUniverse, injectSymbol, _clearInjections } = await import("../../src/strategy/universe.ts");
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
