import { eq } from "drizzle-orm";
import { getQuoteFromCache } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { agentLogs, livePositions } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { Exchange } from "./contracts.ts";
import { placeTrade } from "./orders.ts";
import { findStopLossBreaches } from "./stop-loss.ts";
import { computeTrailingStopUpdate } from "./trailing-stops.ts";

const log = createChildLogger({ module: "guardian" });

const GUARDIAN_INTERVAL_MS = 60_000;
const TRAILING_STOP_ATR_MULTIPLIER = 2;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startGuardian(): void {
	if (intervalHandle) return;
	log.info("Live Guardian started");
	intervalHandle = setInterval(guardianTick, GUARDIAN_INTERVAL_MS);
	guardianTick();
}

export function stopGuardian(): void {
	if (intervalHandle) {
		clearInterval(intervalHandle);
		intervalHandle = null;
		log.info("Live Guardian stopped");
	}
}

async function guardianTick(): Promise<void> {
	try {
		const db = getDb();
		const positionRows = await db.select().from(livePositions);

		if (positionRows.length === 0) return;

		// Build quotes map from cache
		const quotes = new Map<string, { last: number | null; bid: number | null }>();
		for (const pos of positionRows) {
			const cached = await getQuoteFromCache(pos.symbol, pos.exchange);
			if (cached) {
				quotes.set(pos.symbol, { last: cached.last, bid: cached.bid });
			}
		}

		// 1. Stop-loss enforcement
		await enforceStopLosses(positionRows, quotes);

		// 2. Update position prices
		await updatePositionPrices(positionRows, quotes);

		// 3. Trailing stop updates
		await updateTrailingStops(positionRows, quotes);
	} catch (error) {
		log.error({ error }, "Guardian tick failed");
	}
}

async function enforceStopLosses(
	positionRows: Array<{
		id: number;
		symbol: string;
		exchange: string;
		quantity: number;
		stopLossPrice: number | null;
		strategyId: number | null;
	}>,
	quotes: Map<string, { last: number | null; bid: number | null }>,
): Promise<void> {
	const breaches = findStopLossBreaches(positionRows, quotes);

	for (const breach of breaches) {
		const pos = positionRows.find((p) => p.symbol === breach.symbol);
		log.warn(
			{ symbol: breach.symbol, price: breach.price, stopLoss: breach.stopLossPrice },
			"Stop-loss triggered — placing MARKET SELL",
		);

		try {
			await placeTrade({
				strategyId: pos?.strategyId ?? undefined,
				symbol: breach.symbol,
				exchange: (pos?.exchange ?? "LSE") as Exchange,
				side: "SELL",
				quantity: breach.quantity,
				orderType: "MARKET",
				reasoning: `Stop-loss triggered: price ${breach.price} <= stop ${breach.stopLossPrice}`,
				confidence: 1.0,
			});

			const db = getDb();
			await db.insert(agentLogs).values({
				level: "ACTION" as const,
				phase: "guardian",
				message: `Stop-loss executed for ${breach.symbol}: price ${breach.price} <= stop ${breach.stopLossPrice}, sold ${breach.quantity} shares`,
			});
		} catch (error) {
			log.error({ symbol: breach.symbol, error }, "Stop-loss SELL failed");
		}
	}
}

async function updatePositionPrices(
	positionRows: Array<{ id: number; symbol: string; quantity: number; avgCost: number }>,
	quotes: Map<string, { last: number | null; bid: number | null }>,
): Promise<void> {
	const db = getDb();

	for (const pos of positionRows) {
		const quote = quotes.get(pos.symbol);
		const price = quote?.last ?? quote?.bid ?? null;
		if (price === null) continue;

		const marketValue = price * pos.quantity;
		const unrealizedPnl = (price - pos.avgCost) * pos.quantity;

		await db
			.update(livePositions)
			.set({
				currentPrice: price,
				marketValue,
				unrealizedPnl,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(livePositions.id, pos.id));
	}
}

async function updateTrailingStops(
	positionRows: Array<{
		id: number;
		symbol: string;
		exchange: string;
		quantity: number;
		highWaterMark: number | null;
		trailingStopPrice: number | null;
		strategyId: number | null;
	}>,
	quotes: Map<string, { last: number | null; bid: number | null }>,
): Promise<void> {
	const db = getDb();

	for (const pos of positionRows) {
		const quote = quotes.get(pos.symbol);
		const currentPrice = quote?.last ?? quote?.bid ?? null;
		if (!currentPrice) continue;

		// Look up ATR from indicators cache
		let atr14: number | null = null;
		try {
			const { getIndicators } = await import("../strategy/historical.ts");
			const indicators = await getIndicators(pos.symbol, pos.exchange);
			atr14 = indicators?.atr14 ?? null;
		} catch {
			// Indicators not available — skip trailing stop update
		}

		const update = computeTrailingStopUpdate(
			{
				id: pos.id,
				symbol: pos.symbol,
				quantity: pos.quantity,
				highWaterMark: pos.highWaterMark,
				trailingStopPrice: pos.trailingStopPrice,
				atr14,
				currentPrice,
			},
			TRAILING_STOP_ATR_MULTIPLIER,
		);

		if (!update) continue;

		await db
			.update(livePositions)
			.set({
				highWaterMark: update.highWaterMark,
				trailingStopPrice: update.trailingStopPrice,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(livePositions.id, pos.id));

		if (update.triggered) {
			log.warn(
				{
					symbol: pos.symbol,
					price: currentPrice,
					trailingStop: update.trailingStopPrice,
				},
				"Trailing stop triggered — placing MARKET SELL",
			);

			try {
				await placeTrade({
					strategyId: pos.strategyId ?? undefined,
					symbol: pos.symbol,
					exchange: pos.exchange as Exchange,
					side: "SELL",
					quantity: pos.quantity,
					orderType: "MARKET",
					reasoning: `Trailing stop triggered: price ${currentPrice} <= stop ${update.trailingStopPrice.toFixed(2)}`,
					confidence: 1.0,
				});

				await db.insert(agentLogs).values({
					level: "ACTION" as const,
					phase: "guardian",
					message: `Trailing stop executed for ${pos.symbol}: price ${currentPrice} <= trailing stop ${update.trailingStopPrice.toFixed(2)}, sold ${pos.quantity} shares`,
				});
			} catch (error) {
				log.error({ symbol: pos.symbol, error }, "Trailing stop SELL failed");
			}
		}
	}
}
