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

		// 1. Stop-loss enforcement (returns IDs of positions that were closed)
		const closedByStopLoss = await enforceStopLosses(positionRows, quotes);

		// 2. Update position prices
		await updatePositionPrices(positionRows, quotes);

		// 3. Trailing stop updates (skip positions already closed by stop-loss)
		await updateTrailingStops(positionRows, quotes, closedByStopLoss);
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
): Promise<Set<number>> {
	const breaches = findStopLossBreaches(positionRows, quotes);
	const closedIds = new Set<number>();

	for (const breach of breaches) {
		const pos = positionRows.find((p) => p.symbol === breach.symbol);
		const isShort = breach.quantity < 0;
		const side = isShort ? "BUY" : "SELL";
		const absQuantity = Math.abs(breach.quantity);
		log.warn(
			{ symbol: breach.symbol, price: breach.price, stopLoss: breach.stopLossPrice, side },
			`Stop-loss triggered — placing MARKET ${side}`,
		);

		try {
			await placeTrade({
				strategyId: pos?.strategyId ?? undefined,
				symbol: breach.symbol,
				exchange: (pos?.exchange ?? "LSE") as Exchange,
				side,
				quantity: absQuantity,
				orderType: "MARKET",
				reasoning: `Stop-loss triggered: price ${breach.price} <= stop ${breach.stopLossPrice}`,
				confidence: 1.0,
			});

			if (pos) closedIds.add(pos.id);

			const db = getDb();
			const action = isShort ? "covered" : "sold";
			await db.insert(agentLogs).values({
				level: "ACTION" as const,
				phase: "guardian",
				message: `Stop-loss executed for ${breach.symbol}: price ${breach.price} <= stop ${breach.stopLossPrice}, ${action} ${absQuantity} shares`,
			});
		} catch (error) {
			log.error({ symbol: breach.symbol, error }, "Stop-loss SELL failed");
		}
	}

	return closedIds;
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
	closedByStopLoss: Set<number> = new Set(),
): Promise<void> {
	const db = getDb();

	for (const pos of positionRows) {
		// Skip positions already closed by stop-loss enforcement
		if (closedByStopLoss.has(pos.id)) continue;
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
			const isShort = pos.quantity < 0;
			const side = isShort ? "BUY" : "SELL";
			const absQuantity = Math.abs(pos.quantity);
			log.warn(
				{
					symbol: pos.symbol,
					price: currentPrice,
					trailingStop: update.trailingStopPrice,
					side,
				},
				`Trailing stop triggered — placing MARKET ${side}`,
			);

			try {
				await placeTrade({
					strategyId: pos.strategyId ?? undefined,
					symbol: pos.symbol,
					exchange: pos.exchange as Exchange,
					side,
					quantity: absQuantity,
					orderType: "MARKET",
					reasoning: `Trailing stop triggered: price ${currentPrice} <= stop ${update.trailingStopPrice.toFixed(2)}`,
					confidence: 1.0,
				});

				const action = isShort ? "covered" : "sold";
				await db.insert(agentLogs).values({
					level: "ACTION" as const,
					phase: "guardian",
					message: `Trailing stop executed for ${pos.symbol}: price ${currentPrice} <= trailing stop ${update.trailingStopPrice.toFixed(2)}, ${action} ${absQuantity} shares`,
				});
			} catch (error) {
				log.error({ symbol: pos.symbol, error }, "Trailing stop SELL failed");
			}
		}
	}
}
