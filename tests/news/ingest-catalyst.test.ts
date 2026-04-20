import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { resetConfigForTesting } from "../../src/config.ts";
import { closeDb, getDb } from "../../src/db/client.ts";
import { dispatchDecisions, newsEvents, strategies } from "../../src/db/schema.ts";
import { processArticle } from "../../src/news/ingest.ts";
import {
	__setEnqueueForTesting,
	resetCatalystStateForTesting,
} from "../../src/strategy/catalyst-dispatcher.ts";

const originalFlag = process.env.CATALYST_DISPATCH_ENABLED;

interface Captured {
	symbol: string;
	exchange: string;
	newsEventId: number;
}

describe("ingest → catalyst dispatch integration", () => {
	let captured: Captured[] = [];
	let restoreEnqueue: (() => void) | null = null;

	beforeEach(async () => {
		closeDb();
		resetConfigForTesting();
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		await db.delete(dispatchDecisions);
		await db.delete(newsEvents);
		await db.delete(strategies);
		resetCatalystStateForTesting();
		const { _clearInjections } = await import("../../src/strategy/universe.ts");
		_clearInjections();
		process.env.CATALYST_DISPATCH_ENABLED = "true";
		resetConfigForTesting();

		captured = [];
		const prev = __setEnqueueForTesting((symbol, exchange, newsEventId) => {
			captured.push({ symbol, exchange, newsEventId });
		});
		restoreEnqueue = () => {
			__setEnqueueForTesting(prev);
		};
	});

	afterEach(async () => {
		if (restoreEnqueue) {
			restoreEnqueue();
			restoreEnqueue = null;
		}
		if (originalFlag === undefined) delete process.env.CATALYST_DISPATCH_ENABLED;
		else process.env.CATALYST_DISPATCH_ENABLED = originalFlag;
		resetConfigForTesting();
		resetCatalystStateForTesting();
		const { _clearInjections } = await import("../../src/strategy/universe.ts");
		_clearInjections();
	});

	const highUrgencyClassifier = async () => ({
		tradeable: true,
		sentiment: 0.8,
		confidence: 0.9,
		eventType: "earnings_beat",
		urgency: "high" as const,
		signals: null,
	});

	test("high-urgency tradeable news on graduated symbol enqueues catalyst dispatch", async () => {
		const db = getDb();
		await db.insert(strategies).values({
			name: "grad",
			description: "test",
			parameters: "{}",
			signals: JSON.stringify({ entry_long: "rsi14<30", exit: "pnl_pct>0.05" }),
			universe: JSON.stringify(["AAPL:NASDAQ"]),
			status: "active",
		});

		await processArticle(
			{
				headline: "AAPL crushes earnings, raises guidance",
				symbols: ["AAPL"],
				url: "https://example.com/x",
				source: "finnhub",
				publishedAt: new Date(),
				finnhubId: null,
			},
			"NASDAQ",
			highUrgencyClassifier,
		);

		expect(captured.length).toBe(1);
		expect(captured[0]!.symbol).toBe("AAPL");
		expect(captured[0]!.exchange).toBe("NASDAQ");
	});

	test("high-urgency news on non-graduated symbol does NOT enqueue", async () => {
		await processArticle(
			{
				headline: "NOBODY crushes earnings",
				symbols: ["NOBODYTRADES"],
				url: "https://example.com/y",
				source: "finnhub",
				publishedAt: new Date(),
				finnhubId: null,
			},
			"NASDAQ",
			highUrgencyClassifier,
		);

		expect(captured.length).toBe(0);
	});

	test("medium-urgency news does NOT enqueue catalyst dispatch even on graduated symbol", async () => {
		const db = getDb();
		await db.insert(strategies).values({
			name: "grad",
			description: "test",
			parameters: "{}",
			signals: JSON.stringify({ entry_long: "rsi14<30", exit: "pnl_pct>0.05" }),
			universe: JSON.stringify(["AAPL:NASDAQ"]),
			status: "active",
		});

		const mediumClassifier = async () => ({
			tradeable: true,
			sentiment: 0.4,
			confidence: 0.7,
			eventType: "upgrade",
			urgency: "medium" as const,
			signals: null,
		});

		await processArticle(
			{
				headline: "AAPL upgraded by Morgan Stanley",
				symbols: ["AAPL"],
				url: "https://example.com/z",
				source: "finnhub",
				publishedAt: new Date(),
				finnhubId: null,
			},
			"NASDAQ",
			mediumClassifier,
		);

		expect(captured.length).toBe(0);
	});

	test("flag off: no enqueue", async () => {
		process.env.CATALYST_DISPATCH_ENABLED = "false";
		resetConfigForTesting();
		const db = getDb();
		await db.insert(strategies).values({
			name: "grad",
			description: "test",
			parameters: "{}",
			signals: JSON.stringify({ entry_long: "rsi14<30", exit: "pnl_pct>0.05" }),
			universe: JSON.stringify(["AAPL:NASDAQ"]),
			status: "active",
		});

		await processArticle(
			{
				headline: "AAPL crushes earnings",
				symbols: ["AAPL"],
				url: "https://example.com/flag-off",
				source: "finnhub",
				publishedAt: new Date(),
				finnhubId: null,
			},
			"NASDAQ",
			highUrgencyClassifier,
		);

		expect(captured.length).toBe(0);
	});
});
