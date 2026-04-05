import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getQuoteFromCache } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import {
	agentLogs,
	livePositions,
	liveTrades,
	strategies,
} from "../db/schema.ts";
import { type SymbolIndicators, getIndicators } from "../strategy/historical.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { Exchange } from "../broker/contracts.ts";
import { placeTrade } from "../broker/orders.ts";
import { getAvailableCash } from "../broker/settlement.ts";
import type { UnsettledTrade } from "../broker/settlement.ts";
import { computeAllocations, type StrategyTier } from "./capital-allocator.ts";

const log = createChildLogger({ module: "live-executor" });

/** Strategy tiers eligible for live trading */
const LIVE_TIERS: StrategyTier[] = ["probation", "active", "core"];

export interface LiveEvalResult {
	strategiesEvaluated: number;
	tradesPlaced: number;
	errors: string[];
}

/**
 * Run the live executor cycle:
 * 1. Check kill switch
 * 2. Fetch graduated strategies
 * 3. Compute capital allocations (respecting settlement)
 * 4. For each strategy, evaluate signals against market data
 * 5. Place trades for triggered signals
 */
export async function runLiveExecutor(): Promise<LiveEvalResult> {
	const config = getConfig();
	const result: LiveEvalResult = {
		strategiesEvaluated: 0,
		tradesPlaced: 0,
		errors: [],
	};

	// Kill switch check
	if (!config.LIVE_TRADING_ENABLED) {
		log.debug("Live trading disabled — skipping");
		return result;
	}

	const { isConnected } = await import("../broker/connection.ts");
	if (!isConnected()) {
		log.warn("IBKR not connected — skipping live execution");
		result.errors.push("IBKR not connected");
		return result;
	}

	const db = getDb();

	// Fetch graduated strategies
	const graduatedStrategies = await db
		.select()
		.from(strategies)
		.where(inArray(strategies.status, LIVE_TIERS));

	if (graduatedStrategies.length === 0) {
		log.debug("No graduated strategies — skipping");
		return result;
	}

	// Get recent filled trades for settlement calculation
	const recentTrades = await db
		.select({
			fillPrice: liveTrades.fillPrice,
			quantity: liveTrades.quantity,
			side: liveTrades.side,
			exchange: liveTrades.exchange,
			filledAt: liveTrades.filledAt,
		})
		.from(liveTrades)
		.where(
			and(
				eq(liveTrades.status, "FILLED"),
				isNotNull(liveTrades.filledAt),
				isNotNull(liveTrades.fillPrice),
			),
		);

	const unsettledTrades: UnsettledTrade[] = recentTrades
		.filter(
			(t): t is typeof t & { fillPrice: number; filledAt: string } =>
				t.fillPrice !== null && t.filledAt !== null,
		)
		.map((t) => ({
			fillPrice: t.fillPrice,
			quantity: t.quantity,
			side: t.side as "BUY" | "SELL",
			exchange: t.exchange,
			filledAt: t.filledAt,
		}));

	// TODO: Get actual account cash from IBKR API in a future iteration.
	// For now, use a conservative estimate based on known positions.
	const totalCash = await estimateAvailableCash();
	const availableCash = getAvailableCash(totalCash, unsettledTrades);

	if (availableCash <= 0) {
		log.warn("No available cash after settlement — skipping");
		result.errors.push("No available cash");
		return result;
	}

	// Compute allocations
	const allocationInputs = graduatedStrategies.map((s) => ({
		strategyId: s.id,
		tier: s.status as StrategyTier,
	}));
	const allocations = computeAllocations(allocationInputs, availableCash);
	const allocationMap = new Map(allocations.map((a) => [a.strategyId, a]));

	// Evaluate each strategy
	for (const strategy of graduatedStrategies) {
		result.strategiesEvaluated++;
		const allocation = allocationMap.get(strategy.id);
		if (!allocation || allocation.allocatedCapital <= 0) continue;

		try {
			const signals = JSON.parse(strategy.signals ?? "{}");
			const universe: string[] = JSON.parse(strategy.universe ?? "[]");
			const parameters = JSON.parse(strategy.parameters);

			for (const symbol of universe) {
				const exchange = (parameters.exchange ?? "NASDAQ") as Exchange;
				const cached = await getQuoteFromCache(symbol, exchange);
				if (!cached || cached.last == null) continue;

				const indicators = await getIndicators(symbol, exchange);
				if (!indicators) continue;

				// Check for existing position
				const [existingPos] = await db
					.select()
					.from(livePositions)
					.where(
						and(
							eq(livePositions.symbol, symbol),
							eq(livePositions.strategyId, strategy.id),
						),
					)
					.limit(1);

				// Evaluate entry signal (only if no existing position)
				if (!existingPos && signals.entry_long) {
					const shouldEnter = evaluateSignal(
						signals.entry_long,
						parameters,
						cached,
						indicators,
					);

					if (shouldEnter) {
						const positionValue = Math.min(
							allocation.maxPositionSize,
							allocation.allocatedCapital * 0.25,
						);
						const quantity = Math.floor(positionValue / cached.last);

						if (quantity > 0) {
							try {
								await placeTrade({
									strategyId: strategy.id,
									symbol,
									exchange,
									side: "BUY",
									quantity,
									orderType: "LIMIT",
									limitPrice: cached.ask ?? cached.last,
									reasoning: `Strategy ${strategy.name}: entry_long signal triggered`,
									confidence: 0.7,
								});
								result.tradesPlaced++;

								log.info(
									{
										strategyId: strategy.id,
										symbol,
										quantity,
										price: cached.ask ?? cached.last,
									},
									"Live entry trade placed",
								);
							} catch (err) {
								const msg = `Failed to place entry for ${symbol}: ${err}`;
								result.errors.push(msg);
								log.error({ error: err, symbol, strategyId: strategy.id }, msg);
							}
						}
					}
				}

				// Evaluate exit signal (only if we have a position)
				if (existingPos && signals.exit) {
					const shouldExit = evaluateSignal(
						signals.exit,
						parameters,
						cached,
						indicators,
					);

					if (shouldExit) {
						try {
							await placeTrade({
								strategyId: strategy.id,
								symbol,
								exchange,
								side: "SELL",
								quantity: existingPos.quantity,
								orderType: "LIMIT",
								limitPrice: cached.bid ?? cached.last,
								reasoning: `Strategy ${strategy.name}: exit signal triggered`,
								confidence: 0.7,
							});
							result.tradesPlaced++;

							log.info(
								{
									strategyId: strategy.id,
									symbol,
									quantity: existingPos.quantity,
								},
								"Live exit trade placed",
							);
						} catch (err) {
							const msg = `Failed to place exit for ${symbol}: ${err}`;
							result.errors.push(msg);
							log.error({ error: err, symbol, strategyId: strategy.id }, msg);
						}
					}
				}
			}
		} catch (error) {
			const msg = `Strategy ${strategy.id} evaluation failed: ${error}`;
			result.errors.push(msg);
			log.error({ strategyId: strategy.id, error }, msg);
		}
	}

	// Log the cycle
	if (result.tradesPlaced > 0) {
		await db.insert(agentLogs).values({
			level: "ACTION" as const,
			phase: "live-executor",
			message: `Live execution: evaluated ${result.strategiesEvaluated} strategies, placed ${result.tradesPlaced} trades`,
			data: JSON.stringify(result),
		});
	}

	return result;
}

/**
 * Evaluate a signal expression against current market data.
 * Signal expressions are simple rule strings like:
 *   "rsi14 < 30 AND changePercent < -2"
 *   "rsi14 > 70 OR priceAboveSma20 == false"
 *
 * This is a simplified evaluator — matches the paper trading evaluator's logic.
 */
function evaluateSignal(
	_signal: string,
	_parameters: Record<string, unknown>,
	_quote: {
		last: number | null;
		bid: number | null;
		ask: number | null;
		changePercent: number | null;
	},
	_indicators: SymbolIndicators,
): boolean {
	// Signal evaluation delegates to the same LLM-based evaluator used in paper trading.
	// This function is a placeholder — the actual implementation will call the strategy
	// evaluator module which already handles signal interpretation.
	// For Phase 7 MVP, return false (no automatic trading) until evaluator integration is wired.
	return false;
}

/**
 * Estimate available cash from account.
 * In production, this should call IBKR's account summary API.
 * For now, returns a conservative static value from config or position calculation.
 */
async function estimateAvailableCash(): Promise<number> {
	const db = getDb();
	const positions = await db.select().from(livePositions);
	const totalPositionValue = positions.reduce(
		(sum, p) => sum + (p.marketValue ?? p.avgCost * p.quantity),
		0,
	);

	// Conservative estimate: assume we started with known capital
	// This will be replaced with actual IBKR account balance API call
	const STARTING_CAPITAL = 500; // GBP — from spec "£200-500 IBKR regular account"
	return Math.max(0, STARTING_CAPITAL - totalPositionValue);
}

/**
 * Check if live execution diverges significantly from paper assumptions.
 * Logs a warning if slippage > 20% of expected execution cost.
 */
export async function checkBehavioralDivergence(
	strategyId: number,
	symbol: string,
	expectedPrice: number,
	actualFillPrice: number,
): Promise<void> {
	const slippagePct = Math.abs(actualFillPrice - expectedPrice) / expectedPrice;

	if (slippagePct > 0.2) {
		const db = getDb();
		log.warn(
			{
				strategyId,
				symbol,
				expectedPrice,
				actualFillPrice,
				slippagePct: (slippagePct * 100).toFixed(1),
			},
			"Behavioral divergence detected: live slippage > 20%",
		);

		await db.insert(agentLogs).values({
			level: "WARN" as const,
			phase: "live-executor",
			message: `Behavioral divergence: ${symbol} expected ${expectedPrice}, filled at ${actualFillPrice} (${(slippagePct * 100).toFixed(1)}% slippage)`,
			data: JSON.stringify({
				strategyId,
				symbol,
				expectedPrice,
				actualFillPrice,
				slippagePct,
			}),
		});
	}
}
