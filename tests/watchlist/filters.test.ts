import { describe, expect, test } from "bun:test";
import { rankForCapEviction } from "../../src/watchlist/filters.ts";
import type { WatchlistRow } from "../../src/watchlist/repo.ts";

function row(overrides: Partial<WatchlistRow>): WatchlistRow {
	const now = new Date().toISOString();
	return {
		id: 1,
		symbol: "X",
		exchange: "NASDAQ",
		promotedAt: now,
		lastCatalystAt: now,
		promotionReasons: "news",
		catalystSummary: null,
		directionalBias: null,
		horizon: null,
		researchPayload: null,
		enrichedAt: null,
		enrichmentFailedAt: null,
		expiresAt: now,
		demotedAt: null,
		demotionReason: null,
		...overrides,
	} as WatchlistRow;
}

describe("rankForCapEviction", () => {
	test("ranks more-recent catalysts higher (keep them, evict older)", () => {
		const recent = row({ id: 1, lastCatalystAt: new Date().toISOString() });
		const old = row({ id: 2, lastCatalystAt: new Date(Date.now() - 48 * 3600_000).toISOString() });
		const ranked = rankForCapEviction([old, recent]);
		expect(ranked[0]?.id).toBe(1);
		expect(ranked[ranked.length - 1]?.id).toBe(2);
	});

	test("breaks ties by number of promotion reasons (more reasons = higher rank)", () => {
		const now = new Date().toISOString();
		const oneReason = row({ id: 1, lastCatalystAt: now, promotionReasons: "news" });
		const twoReasons = row({ id: 2, lastCatalystAt: now, promotionReasons: "news,earnings" });
		const ranked = rankForCapEviction([oneReason, twoReasons]);
		expect(ranked[0]?.id).toBe(2);
	});
});
