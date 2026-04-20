import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../../src/db/client.ts";
import { symbolCiks } from "../../../src/db/schema.ts";
import {
	getCikForSymbol,
	getCiksForSymbols,
	refreshCikMap,
} from "../../../src/universe/ciks/edgar-ticker-map.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

const SAMPLE_RESPONSE = {
	"0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
	"1": { cik_str: 789019, ticker: "MSFT", title: "Microsoft Corp" },
	"2": { cik_str: 1018724, ticker: "AMZN", title: "Amazon.com Inc." },
};

describe("refreshCikMap", () => {
	test("upserts rows from SEC company_tickers response", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			json: async () => SAMPLE_RESPONSE,
		});
		const count = await refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch });
		expect(count).toBe(3);

		const rows = await getDb().select().from(symbolCiks).all();
		// 3 tickers × 2 exchanges (NASDAQ + NYSE) = 6 rows
		expect(rows.length).toBe(6);
		const aaplNasdaq = rows.find((r) => r.symbol === "AAPL" && r.exchange === "NASDAQ");
		expect(aaplNasdaq?.cik).toBe(320193);
		expect(aaplNasdaq?.entityName).toBe("Apple Inc.");
	});

	test("idempotent — second call updates rather than duplicates", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			json: async () => SAMPLE_RESPONSE,
		});
		await refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch });
		await refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch });
		const rows = await getDb().select().from(symbolCiks).all();
		expect(rows.length).toBe(6);
	});

	test("throws on non-200", async () => {
		const fetchStub = async () => ({ ok: false, status: 500, json: async () => ({}) });
		await expect(
			refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch }),
		).rejects.toThrow(/SEC company_tickers/);
	});
});

describe("getCikForSymbol", () => {
	test("returns CIK for cached symbol", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			json: async () => SAMPLE_RESPONSE,
		});
		await refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch });
		const cik = await getCikForSymbol("AAPL", "NASDAQ");
		expect(cik).toBe(320193);
	});

	test("returns null for unknown symbol", async () => {
		const cik = await getCikForSymbol("ZZZZZ", "NASDAQ");
		expect(cik).toBeNull();
	});
});

describe("getCiksForSymbols", () => {
	test("returns Map for multiple refs", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			json: async () => SAMPLE_RESPONSE,
		});
		await refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch });

		const out = await getCiksForSymbols([
			{ symbol: "AAPL", exchange: "NASDAQ" },
			{ symbol: "MSFT", exchange: "NASDAQ" },
			{ symbol: "GHOST", exchange: "NASDAQ" },
		]);
		expect(out.size).toBe(2);
		expect(out.get("AAPL:NASDAQ")).toBe(320193);
		expect(out.get("MSFT:NASDAQ")).toBe(789019);
		expect(out.has("GHOST:NASDAQ")).toBe(false);
	});

	test("returns empty map for empty input without querying DB", async () => {
		const out = await getCiksForSymbols([]);
		expect(out.size).toBe(0);
	});
});
