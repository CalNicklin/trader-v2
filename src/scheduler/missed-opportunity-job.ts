// src/scheduler/missed-opportunity-job.ts
import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsAnalyses, quotesCache, tradeInsights } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "missed-opportunity" });

const DAILY_THRESHOLD_PCT = 2;
const WEEKLY_THRESHOLD_PCT = 5;

async function getCurrentPrice(symbol: string, exchange: string): Promise<number | null> {
	const db = getDb();
	const [cached] = await db
		.select({ last: quotesCache.last, updatedAt: quotesCache.updatedAt })
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, symbol), eq(quotesCache.exchange, exchange)))
		.limit(1);

	if (cached?.last != null) {
		// Check if price is stale (older than 24h)
		if (cached.updatedAt) {
			const ageMs = Date.now() - new Date(cached.updatedAt).getTime();
			if (ageMs < 24 * 60 * 60 * 1000) return cached.last;
		} else {
			return cached.last;
		}
	}

	// Fallback: Finnhub /quote
	try {
		const { getConfig } = await import("../config.ts");
		const config = getConfig();
		if (!config.FINNHUB_API_KEY) return cached?.last ?? null;

		const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${config.FINNHUB_API_KEY}`;
		const res = await fetch(url);
		if (!res.ok) return cached?.last ?? null;
		const data = (await res.json()) as Record<string, unknown>;
		const price = data.c;
		return typeof price === "number" && price > 0 ? price : (cached?.last ?? null);
	} catch {
		return cached?.last ?? null;
	}
}

function computeChangePct(currentPrice: number, analysisPrice: number): number {
	return ((currentPrice - analysisPrice) / analysisPrice) * 100;
}

function isCorrectDirection(changePct: number, direction: string): boolean {
	if (direction === "long") return changePct > 0;
	if (direction === "short") return changePct < 0;
	return false;
}

export async function runDailyMissedOpportunityReview(): Promise<{
	reviewed: number;
	missed: number;
}> {
	const db = getDb();
	const now = Date.now();
	const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
	const cutoff48h = new Date(now - 48 * 60 * 60 * 1000).toISOString();

	// Get analyses from 24-48 hours ago with priceAtAnalysis set and no priceAfter1d yet
	const rows = await db
		.select()
		.from(newsAnalyses)
		.where(
			and(
				gte(newsAnalyses.createdAt, cutoff48h),
				lt(newsAnalyses.createdAt, cutoff24h),
				isNotNull(newsAnalyses.priceAtAnalysis),
				isNull(newsAnalyses.priceAfter1d),
			),
		);

	let missed = 0;

	for (const row of rows) {
		const currentPrice = await getCurrentPrice(row.symbol, row.exchange);
		if (currentPrice == null) {
			log.debug({ symbol: row.symbol }, "No current price available — skipping");
			continue;
		}

		// Update priceAfter1d
		await db
			.update(newsAnalyses)
			.set({ priceAfter1d: currentPrice })
			.where(eq(newsAnalyses.id, row.id));

		// Check for missed opportunity (only for out-of-universe symbols)
		if (!row.inUniverse && row.direction !== "avoid") {
			const changePct = computeChangePct(currentPrice, row.priceAtAnalysis!);
			const absChangePct = Math.abs(changePct);

			if (absChangePct > DAILY_THRESHOLD_PCT && isCorrectDirection(changePct, row.direction)) {
				await db.insert(tradeInsights).values({
					strategyId: null,
					insightType: "missed_opportunity",
					observation: `${row.symbol} moved ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}% (predicted ${row.direction}). Thesis: ${row.tradeThesis}`,
					tags: JSON.stringify(["missed_opportunity", row.eventType, row.symbol]),
					confidence: row.confidence,
				});
				missed++;
				log.info(
					{ symbol: row.symbol, changePct: changePct.toFixed(1), direction: row.direction },
					"Missed opportunity detected",
				);
			}
		}
	}

	log.info({ reviewed: rows.length, missed }, "Daily missed opportunity review complete");
	return { reviewed: rows.length, missed };
}

export async function runWeeklyMissedOpportunityReview(): Promise<{
	reviewed: number;
	missed: number;
}> {
	const db = getDb();
	const now = Date.now();
	const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
	const cutoff8d = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

	// Get analyses from 7-8 days ago with priceAtAnalysis set and no priceAfter1w yet
	const rows = await db
		.select()
		.from(newsAnalyses)
		.where(
			and(
				gte(newsAnalyses.createdAt, cutoff8d),
				lt(newsAnalyses.createdAt, cutoff7d),
				isNotNull(newsAnalyses.priceAtAnalysis),
				isNull(newsAnalyses.priceAfter1w),
			),
		);

	let missed = 0;

	for (const row of rows) {
		const currentPrice = await getCurrentPrice(row.symbol, row.exchange);
		if (currentPrice == null) continue;

		// Update priceAfter1w
		await db
			.update(newsAnalyses)
			.set({ priceAfter1w: currentPrice })
			.where(eq(newsAnalyses.id, row.id));

		// Only log if not already a daily missed opportunity AND > 5% move
		if (!row.inUniverse && row.direction !== "avoid") {
			const changePct = computeChangePct(currentPrice, row.priceAtAnalysis!);
			const absChangePct = Math.abs(changePct);

			// Check if daily already logged this
			const existingMiss = await db
				.select({ id: tradeInsights.id })
				.from(tradeInsights)
				.where(
					and(
						eq(tradeInsights.insightType, "missed_opportunity"),
						sql`${tradeInsights.tags} LIKE ${`%${row.symbol}%`}`,
						sql`${tradeInsights.observation} LIKE ${`%${row.symbol}%`}`,
					),
				)
				.limit(1);

			if (
				existingMiss.length === 0 &&
				absChangePct > WEEKLY_THRESHOLD_PCT &&
				isCorrectDirection(changePct, row.direction)
			) {
				await db.insert(tradeInsights).values({
					strategyId: null,
					insightType: "missed_opportunity",
					observation: `[1W] ${row.symbol} moved ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}% over 1 week (predicted ${row.direction}). Thesis: ${row.tradeThesis}`,
					tags: JSON.stringify(["missed_opportunity", "weekly", row.eventType, row.symbol]),
					confidence: row.confidence,
				});
				missed++;
			}
		}
	}

	log.info({ reviewed: rows.length, missed }, "Weekly missed opportunity review complete");
	return { reviewed: rows.length, missed };
}
