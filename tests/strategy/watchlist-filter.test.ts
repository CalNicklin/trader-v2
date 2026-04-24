import { afterEach, beforeEach, describe, expect, test } from "bun:test";

describe("parseWatchlistFilter (TRA-20)", () => {
	test("returns null for null or empty input", async () => {
		const { parseWatchlistFilter } = await import("../../src/strategy/watchlist-filter.ts");
		expect(parseWatchlistFilter(null)).toBeNull();
		expect(parseWatchlistFilter("")).toBeNull();
	});

	test("returns null for invalid JSON", async () => {
		const { parseWatchlistFilter } = await import("../../src/strategy/watchlist-filter.ts");
		expect(parseWatchlistFilter("not json")).toBeNull();
		expect(parseWatchlistFilter("{")).toBeNull();
	});

	test("returns null for missing required fields", async () => {
		const { parseWatchlistFilter } = await import("../../src/strategy/watchlist-filter.ts");
		expect(parseWatchlistFilter(JSON.stringify({}))).toBeNull();
		expect(parseWatchlistFilter(JSON.stringify({ promotionReasons: ["news"] }))).toBeNull();
	});

	test("parses a valid filter", async () => {
		const { parseWatchlistFilter } = await import("../../src/strategy/watchlist-filter.ts");
		const raw = JSON.stringify({
			promotionReasons: ["news", "research"],
			enrichedRequired: true,
			horizons: ["intraday", "days"],
			directionalBiases: ["long", "short"],
			exchanges: ["NASDAQ"],
		});
		const parsed = parseWatchlistFilter(raw);
		expect(parsed).not.toBeNull();
		expect(parsed!.promotionReasons).toEqual(["news", "research"]);
		expect(parsed!.enrichedRequired).toBe(true);
	});
});

describe("getEffectiveUniverseForStrategy (TRA-20)", () => {
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

	afterEach(async () => {
		delete process.env.USE_WATCHLIST;
		process.env.WATCHLIST_MIN_ACTIVATION_SYMBOLS = "0";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
	});

	test("returns static universe when watchlistFilter is null", async () => {
		const { getEffectiveUniverseForStrategy } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		const result = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: JSON.stringify(["AAPL", "MSFT"]),
			watchlistFilter: null,
		});
		expect(result.source).toBe("static");
		expect(result.universe).toEqual(["AAPL", "MSFT"]);
	});

	test("returns static universe when USE_WATCHLIST is false even with filter set", async () => {
		process.env.USE_WATCHLIST = "false";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();

		const { getEffectiveUniverseForStrategy } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		const result = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: JSON.stringify(["AAPL"]),
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: false,
				horizons: [],
				directionalBiases: [],
			}),
		});
		expect(result.source).toBe("static");
		expect(result.universe).toEqual(["AAPL"]);
	});

	test("returns watchlist universe when USE_WATCHLIST is true and filter is set", async () => {
		process.env.USE_WATCHLIST = "true";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();

		const { watchlist } = await import("../../src/db/schema.ts");
		await db.insert(watchlist).values([
			{
				symbol: "NFLX",
				exchange: "NASDAQ",
				promotedAt: new Date().toISOString(),
				lastCatalystAt: new Date().toISOString(),
				promotionReasons: "news",
				horizon: "days",
				directionalBias: "long",
				enrichedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
			},
			{
				symbol: "TSLA",
				exchange: "NASDAQ",
				promotedAt: new Date().toISOString(),
				lastCatalystAt: new Date().toISOString(),
				promotionReasons: "earnings", // excluded by filter
				horizon: "days",
				directionalBias: "long",
				enrichedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
			},
		]);

		const { getEffectiveUniverseForStrategy } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		const result = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: JSON.stringify(["AAPL"]),
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news", "research"],
				enrichedRequired: true,
				horizons: ["intraday", "days"],
				directionalBiases: ["long", "short", "ambiguous"],
			}),
		});

		expect(result.source).toBe("watchlist");
		expect(result.universe).toEqual(["NFLX:NASDAQ"]);
	});

	test("falls back to static when watchlist matches fewer than the min threshold (TRA-40)", async () => {
		// Regression: strategy 1's news/research filter drained to 0 every morning
		// after the demotion sweep. The fallback keeps the strategy trading on
		// static until the watchlist refills.
		process.env.USE_WATCHLIST = "true";
		process.env.WATCHLIST_MIN_ACTIVATION_SYMBOLS = "5";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();

		const { watchlist } = await import("../../src/db/schema.ts");
		// Insert 2 matching rows — below the default threshold of 5.
		await db.insert(watchlist).values([
			{
				symbol: "NFLX",
				exchange: "NASDAQ",
				promotedAt: new Date().toISOString(),
				lastCatalystAt: new Date().toISOString(),
				promotionReasons: "news",
				horizon: "days",
				directionalBias: "long",
				enrichedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
			},
			{
				symbol: "PYPL",
				exchange: "NASDAQ",
				promotedAt: new Date().toISOString(),
				lastCatalystAt: new Date().toISOString(),
				promotionReasons: "news",
				horizon: "days",
				directionalBias: "short",
				enrichedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
			},
		]);

		const { getEffectiveUniverseForStrategy } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		const result = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: JSON.stringify(["AAPL", "MSFT"]),
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: true,
				horizons: [],
				directionalBiases: [],
			}),
		});
		expect(result.source).toBe("static_fallback");
		expect(result.universe).toEqual(["AAPL", "MSFT"]);
	});

	test("uses watchlist when size meets the min threshold (TRA-40)", async () => {
		process.env.USE_WATCHLIST = "true";
		process.env.WATCHLIST_MIN_ACTIVATION_SYMBOLS = "5";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();

		const { watchlist } = await import("../../src/db/schema.ts");
		// Insert 5 matching rows — at the threshold, should stay on watchlist path.
		const symbols = ["NFLX", "PYPL", "TSLA", "AMZN", "AAPL"];
		for (const symbol of symbols) {
			await db.insert(watchlist).values({
				symbol,
				exchange: "NASDAQ",
				promotedAt: new Date().toISOString(),
				lastCatalystAt: new Date().toISOString(),
				promotionReasons: "news",
				horizon: "days",
				directionalBias: "long",
				enrichedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
			});
		}

		const { getEffectiveUniverseForStrategy } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		const result = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: JSON.stringify(["MSFT"]),
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: true,
				horizons: [],
				directionalBiases: [],
			}),
		});
		expect(result.source).toBe("watchlist");
		expect(result.universe).toHaveLength(5);
	});

	test("WATCHLIST_MIN_ACTIVATION_SYMBOLS is 5 by default", async () => {
		const { WATCHLIST_MIN_ACTIVATION_SYMBOLS } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		expect(WATCHLIST_MIN_ACTIVATION_SYMBOLS).toBe(5);
	});

	test("falls back to static when watchlist has no matching rows (TRA-40)", async () => {
		process.env.USE_WATCHLIST = "true";
		process.env.WATCHLIST_MIN_ACTIVATION_SYMBOLS = "5";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();

		const { getEffectiveUniverseForStrategy } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		const result = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: JSON.stringify(["AAPL"]),
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: true,
				horizons: [],
				directionalBiases: [],
			}),
		});
		// Pre-TRA-40 this returned source=watchlist, universe=[]. Post-TRA-40 the
		// fallback kicks in so the strategy keeps trading on static.
		expect(result.source).toBe("static_fallback");
		expect(result.universe).toEqual(["AAPL"]);
	});

	test("enrichedRequired=true excludes rows with null enriched_at", async () => {
		process.env.USE_WATCHLIST = "true";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();

		const { watchlist } = await import("../../src/db/schema.ts");
		await db.insert(watchlist).values({
			symbol: "NFLX",
			exchange: "NASDAQ",
			promotedAt: new Date().toISOString(),
			lastCatalystAt: new Date().toISOString(),
			promotionReasons: "news",
			horizon: "days",
			directionalBias: "long",
			enrichedAt: null, // unenriched
			expiresAt: new Date(Date.now() + 86400000).toISOString(),
		});

		const { getEffectiveUniverseForStrategy } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		const withEnrichReq = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: null,
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: true,
				horizons: [],
				directionalBiases: [],
			}),
		});
		expect(withEnrichReq.universe).toEqual([]);

		const withoutEnrichReq = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: null,
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: false,
				horizons: [],
				directionalBiases: [],
			}),
		});
		expect(withoutEnrichReq.universe).toEqual(["NFLX:NASDAQ"]);
	});

	test("exchange filter narrows across LSE/NASDAQ", async () => {
		process.env.USE_WATCHLIST = "true";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();

		const { watchlist } = await import("../../src/db/schema.ts");
		await db.insert(watchlist).values([
			{
				symbol: "NFLX",
				exchange: "NASDAQ",
				promotedAt: new Date().toISOString(),
				lastCatalystAt: new Date().toISOString(),
				promotionReasons: "news",
				horizon: "days",
				directionalBias: "long",
				enrichedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
			},
			{
				symbol: "BP.",
				exchange: "LSE",
				promotedAt: new Date().toISOString(),
				lastCatalystAt: new Date().toISOString(),
				promotionReasons: "news",
				horizon: "days",
				directionalBias: "long",
				enrichedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
			},
		]);

		const { getEffectiveUniverseForStrategy } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		const result = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: null,
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: true,
				horizons: [],
				directionalBiases: [],
				exchanges: ["LSE"],
			}),
		});
		expect(result.universe).toEqual(["BP.:LSE"]);
	});

	test("excludes demoted rows", async () => {
		process.env.USE_WATCHLIST = "true";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();

		const { watchlist } = await import("../../src/db/schema.ts");
		await db.insert(watchlist).values({
			symbol: "NFLX",
			exchange: "NASDAQ",
			promotedAt: new Date().toISOString(),
			lastCatalystAt: new Date().toISOString(),
			promotionReasons: "news",
			horizon: "days",
			directionalBias: "long",
			enrichedAt: new Date().toISOString(),
			demotedAt: new Date().toISOString(), // ← demoted
			demotionReason: "test",
			expiresAt: new Date(Date.now() + 86400000).toISOString(),
		});

		const { getEffectiveUniverseForStrategy } = await import(
			"../../src/strategy/watchlist-filter.ts"
		);
		const result = await getEffectiveUniverseForStrategy({
			id: 1,
			universe: null,
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: true,
				horizons: [],
				directionalBiases: [],
			}),
		});
		expect(result.universe).toEqual([]);
	});
});

describe("compareUniverses (TRA-20)", () => {
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

	test("returns null when watchlistFilter is null", async () => {
		const { compareUniverses } = await import("../../src/strategy/watchlist-filter.ts");
		const result = await compareUniverses({
			id: 1,
			universe: JSON.stringify(["AAPL"]),
			watchlistFilter: null,
		});
		expect(result).toBeNull();
	});

	test("bare static symbol and qualified watchlist symbol are treated as the same entry", async () => {
		// Regression: the parity log must not count bare "AAPL" in the static
		// universe and "AAPL:NASDAQ" on the watchlist as divergent — they
		// describe the same (symbol, exchange) pair.
		const { watchlist } = await import("../../src/db/schema.ts");
		await db.insert(watchlist).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			promotedAt: new Date().toISOString(),
			lastCatalystAt: new Date().toISOString(),
			promotionReasons: "news",
			horizon: "days",
			directionalBias: "long",
			enrichedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 86400000).toISOString(),
		});

		const { compareUniverses } = await import("../../src/strategy/watchlist-filter.ts");
		const result = await compareUniverses({
			id: 1,
			universe: JSON.stringify(["AAPL"]),
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: true,
				horizons: [],
				directionalBiases: [],
			}),
		});
		expect(result).not.toBeNull();
		expect(result!.onlyStatic).toEqual([]);
		expect(result!.onlyWatchlist).toEqual([]);
		expect(result!.inBoth).toEqual(["AAPL"]); // keeps original spelling
	});

	test("computes symmetric difference and intersection", async () => {
		const { watchlist } = await import("../../src/db/schema.ts");
		await db.insert(watchlist).values([
			{
				symbol: "NFLX",
				exchange: "NASDAQ",
				promotedAt: new Date().toISOString(),
				lastCatalystAt: new Date().toISOString(),
				promotionReasons: "news",
				horizon: "days",
				directionalBias: "long",
				enrichedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
			},
		]);

		const { compareUniverses } = await import("../../src/strategy/watchlist-filter.ts");
		const result = await compareUniverses({
			id: 1,
			universe: JSON.stringify(["AAPL", "MSFT"]),
			watchlistFilter: JSON.stringify({
				promotionReasons: ["news"],
				enrichedRequired: true,
				horizons: [],
				directionalBiases: [],
			}),
		});
		expect(result).not.toBeNull();
		expect(result!.onlyStatic).toEqual(["AAPL", "MSFT"]);
		expect(result!.onlyWatchlist).toEqual(["NFLX:NASDAQ"]);
		expect(result!.inBoth).toEqual([]);
	});
});
