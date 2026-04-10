import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsEvents } from "../../src/db/schema.ts";
import { storeNewsEvent } from "../../src/news/sentiment-writer.ts";

describe("sentiment writer", () => {
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

	test("stores news event in news_events table", async () => {
		const { storeNewsEvent } = await import("../../src/news/sentiment-writer.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		await storeNewsEvent({
			source: "finnhub",
			headline: "Apple beats earnings",
			url: "https://example.com",
			symbols: ["AAPL"],
			sentiment: 0.8,
			confidence: 0.9,
			tradeable: true,
			eventType: "earnings_beat",
			urgency: "high" as const,
			signals: null,
		});

		const rows = await db.select().from(newsEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.headline).toBe("Apple beats earnings");
		expect(rows[0]!.tradeable).toBe(true);
		expect(rows[0]!.sentiment).toBeCloseTo(0.8);
		expect(rows[0]!.classifiedAt).not.toBeNull();
	});

	test("storeNewsEvent stores signal fields in news_events table", async () => {
		const { storeNewsEvent } = await import("../../src/news/sentiment-writer.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		await storeNewsEvent({
			source: "finnhub",
			headline: "Apple beats earnings with strong guidance",
			url: "https://example.com",
			symbols: ["AAPL"],
			sentiment: 0.8,
			confidence: 0.9,
			tradeable: true,
			eventType: "earnings_beat",
			urgency: "high" as const,
			signals: {
				earningsSurprise: 0.9,
				guidanceChange: 0.6,
				managementTone: 0.7,
				regulatoryRisk: 0.0,
				acquisitionLikelihood: 0.0,
				catalystType: "fundamental",
				expectedMoveDuration: "1-3d",
			},
		});

		const rows = await db.select().from(newsEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.earningsSurprise).toBeCloseTo(0.9);
		expect(rows[0]!.guidanceChange).toBeCloseTo(0.6);
		expect(rows[0]!.managementTone).toBeCloseTo(0.7);
		expect(rows[0]!.catalystType).toBe("fundamental");
	});

	test("storeNewsEvent handles null signals", async () => {
		const { storeNewsEvent } = await import("../../src/news/sentiment-writer.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		await storeNewsEvent({
			source: "finnhub",
			headline: "Routine board appointment at XYZ Corp",
			url: null,
			symbols: ["XYZ"],
			sentiment: null,
			confidence: null,
			tradeable: null,
			eventType: null,
			urgency: null,
			signals: null,
		});

		const rows = await db.select().from(newsEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.earningsSurprise).toBeNull();
		expect(rows[0]!.catalystType).toBeNull();
	});
});

describe("storeNewsEvent returns ID", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	afterEach(() => {
		closeDb();
	});

	test("returns the inserted news event ID", async () => {
		const id = await storeNewsEvent({
			source: "finnhub",
			headline: "Broadcom and Google seal five-year AI chip partnership",
			url: "https://example.com/article",
			symbols: ["GOOGL", "AVGO"],
			sentiment: 0.2,
			confidence: 0.7,
			tradeable: true,
			eventType: "partnership",
			urgency: "low",
			signals: null,
		});

		expect(typeof id).toBe("number");
		expect(id).toBeGreaterThan(0);

		const db = getDb();
		const rows = await db.select().from(newsEvents);
		expect(rows.length).toBe(1);
		expect(rows[0]!.id).toBe(id);
	});
});
