import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { catalystEvents } from "../../src/db/schema.ts";
import { markLedToPromotion, writeCatalystEvent } from "../../src/watchlist/catalyst-events.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => closeDb());

describe("writeCatalystEvent", () => {
	test("inserts row with defaults and returns id", () => {
		const id = writeCatalystEvent({
			symbol: "AAPL",
			exchange: "NASDAQ",
			eventType: "news",
			source: "news_event_42",
			payload: { headline: "Apple beats" },
		});
		expect(typeof id).toBe("number");

		const row = getDb().select().from(catalystEvents).where(eq(catalystEvents.id, id)).get();
		expect(row?.ledToPromotion).toBe(false);
		expect(row?.firedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(JSON.parse(row?.payload ?? "null")).toEqual({ headline: "Apple beats" });
	});

	test("accepts null payload", () => {
		const id = writeCatalystEvent({
			symbol: "AAPL",
			exchange: "NASDAQ",
			eventType: "volume",
			source: "volume-job",
			payload: null,
		});
		const row = getDb().select().from(catalystEvents).where(eq(catalystEvents.id, id)).get();
		expect(row?.payload).toBeNull();
	});
});

describe("markLedToPromotion", () => {
	test("flips led_to_promotion to true", () => {
		const id = writeCatalystEvent({
			symbol: "AAPL",
			exchange: "NASDAQ",
			eventType: "news",
			source: "news_event_42",
			payload: null,
		});
		markLedToPromotion(id);
		const row = getDb().select().from(catalystEvents).where(eq(catalystEvents.id, id)).get();
		expect(row?.ledToPromotion).toBe(true);
	});
});
