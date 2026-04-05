import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { placeTrade } from "../broker/orders.ts";
import type { UnsettledTrade } from "../broker/settlement.ts";
import { getAvailableCash } from "../broker/settlement.ts";
import { getConfig } from "../config.ts";
import { getQuoteFromCache } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { agentLogs, livePositions, liveTrades, strategies } from "../db/schema.ts";
import { checkTradeRiskGate } from "../risk/gate.ts";
import { isTradingHalted, isWeeklyDrawdownActive } from "../risk/guardian.ts";
import { buildSignalContext, type PositionFields, type QuoteFields } from "../strategy/context.ts";
import { evalExpr } from "../strategy/expr-eval.ts";
import { getIndicators, type SymbolIndicators } from "../strategy/historical.ts";
import { createChildLogger } from "../utils/logger.ts";
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

	// Risk guardian halt check
	const haltStatus = await isTradingHalted();
	if (haltStatus.halted) {
		log.warn(
			{ reason: haltStatus.reason },
			"Trading halted by risk guardian — skipping live execution",
		);
		result.errors.push(`Trading halted: ${haltStatus.reason}`);
		return result;
	}

	const weeklyDrawdownActive = await isWeeklyDrawdownActive();

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

	let totalCash: number;
	try {
		const { getAccountSummary } = await import("../broker/account.ts");
		const summary = await getAccountSummary();
		totalCash = summary.totalCashValue;
	} catch (err) {
		log.warn({ error: err }, "Failed to get IBKR account summary — using position estimate");
		totalCash = await estimateAvailableCash();
	}
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

				// Check for existing position (by this strategy)
				const [existingPos] = await db
					.select()
					.from(livePositions)
					.where(and(eq(livePositions.symbol, symbol), eq(livePositions.strategyId, strategy.id)))
					.limit(1);

				// Guard against UNIQUE(symbol, exchange) constraint — check if
				// any other strategy already holds this symbol on this exchange
				if (!existingPos) {
					const [conflictingPos] = await db
						.select({ id: livePositions.id })
						.from(livePositions)
						.where(and(eq(livePositions.symbol, symbol), eq(livePositions.exchange, exchange)))
						.limit(1);
					if (conflictingPos) {
						log.debug(
							{ symbol, exchange, strategyId: strategy.id },
							"Skipping — another strategy already holds this symbol",
						);
						continue;
					}
				}

				// Evaluate entry signal (only if no existing position)
				if (!existingPos && signals.entry_long) {
					const shouldEnter = evaluateSignal(signals.entry_long, parameters, cached, indicators);

					if (shouldEnter) {
						// Count existing live positions for risk gate
						const allPositions = await db.select({ id: livePositions.id }).from(livePositions);

						const gateResult = checkTradeRiskGate({
							accountBalance: availableCash,
							price: cached.last,
							atr14: indicators.atr14 ?? 0,
							side: "BUY",
							exchange,
							sector: null,
							borrowFeeAnnualPct: null,
							openPositionCount: allPositions.length,
							openPositionSectors: allPositions.map(() => null),
							weeklyDrawdownActive,
						});

						if (!gateResult.allowed) {
							log.debug(
								{ symbol, reason: gateResult.reason, strategyId: strategy.id },
								"Trade rejected by risk gate",
							);
							continue;
						}

						const { quantity: gateQty, stopLossPrice } = gateResult.sizing!;
						// Cap at capital allocator limit
						const quantity = Math.min(
							gateQty,
							Math.floor(allocation.maxPositionSize / cached.last),
						);

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
									stopLossPrice,
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

				// Evaluate entry_short signal (only if no existing position)
				if (!existingPos && signals.entry_short) {
					const shouldShort = evaluateSignal(signals.entry_short, parameters, cached, indicators);

					if (shouldShort) {
						// Count existing live positions for risk gate
						const allPositions = await db.select({ id: livePositions.id }).from(livePositions);

						const gateResult = checkTradeRiskGate({
							accountBalance: availableCash,
							price: cached.last,
							atr14: indicators.atr14 ?? 0,
							side: "SELL",
							exchange,
							sector: null,
							borrowFeeAnnualPct: null,
							openPositionCount: allPositions.length,
							openPositionSectors: allPositions.map(() => null),
							weeklyDrawdownActive,
						});

						if (!gateResult.allowed) {
							log.debug(
								{ symbol, reason: gateResult.reason, strategyId: strategy.id },
								"Short trade rejected by risk gate",
							);
							continue;
						}

						const { quantity: gateQty, stopLossPrice: shortStopLoss } = gateResult.sizing!;
						// Cap at capital allocator limit
						const quantity = Math.min(
							gateQty,
							Math.floor(allocation.maxPositionSize / cached.last),
						);

						if (quantity > 0) {
							try {
								await placeTrade({
									strategyId: strategy.id,
									symbol,
									exchange,
									side: "SELL",
									quantity,
									orderType: "LIMIT",
									limitPrice: cached.bid ?? cached.last,
									reasoning: `Strategy ${strategy.name}: entry_short signal triggered`,
									confidence: 0.7,
									stopLossPrice: shortStopLoss,
								});
								result.tradesPlaced++;

								log.info(
									{
										strategyId: strategy.id,
										symbol,
										quantity,
										price: cached.bid ?? cached.last,
									},
									"Live short entry trade placed",
								);
							} catch (err) {
								const msg = `Failed to place short entry for ${symbol}: ${err}`;
								result.errors.push(msg);
								log.error({ error: err, symbol, strategyId: strategy.id }, msg);
							}
						}
					}
				}

				// Evaluate exit signal (only if we have a position)
				if (existingPos && signals.exit) {
					const shouldExit = evaluateSignal(signals.exit, parameters, cached, indicators, {
						entryPrice: existingPos.avgCost,
						openedAt: existingPos.updatedAt,
						quantity: existingPos.quantity,
					});

					if (shouldExit) {
						const isShortExit = existingPos.quantity < 0;
						try {
							await placeTrade({
								strategyId: strategy.id,
								symbol,
								exchange,
								side: isShortExit ? "BUY" : "SELL",
								quantity: Math.abs(existingPos.quantity),
								orderType: "LIMIT",
								limitPrice: isShortExit ? (cached.ask ?? cached.last) : (cached.bid ?? cached.last),
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
 * Build signal context for the live executor.
 * Exported for testing — same context builder as paper evaluator.
 */
export function buildLiveSignalContext(
	quote: QuoteFields,
	indicators: SymbolIndicators,
	position: PositionFields | null,
): Record<string, number | null | undefined> {
	return buildSignalContext({ quote, indicators, position });
}

/**
 * Evaluate a signal expression against current market data.
 * Uses the same buildSignalContext + evalExpr pipeline as paper trading.
 */
function evaluateSignal(
	signal: string,
	_parameters: Record<string, unknown>,
	quote: {
		last: number | null;
		bid: number | null;
		ask: number | null;
		changePercent: number | null;
	},
	indicators: SymbolIndicators,
	position?: { entryPrice: number; openedAt: string; quantity: number },
): boolean {
	const fullQuote: QuoteFields = {
		last: quote.last,
		bid: quote.bid,
		ask: quote.ask,
		volume: null,
		avgVolume: null,
		changePercent: quote.changePercent,
		newsSentiment: null,
		newsEarningsSurprise: null,
		newsGuidanceChange: null,
		newsManagementTone: null,
		newsRegulatoryRisk: null,
		newsAcquisitionLikelihood: null,
		newsCatalystType: null,
		newsExpectedMoveDuration: null,
	};
	const posFields: PositionFields | null = position
		? { entryPrice: position.entryPrice, openedAt: position.openedAt, quantity: position.quantity }
		: null;
	const ctx = buildSignalContext({ quote: fullQuote, indicators, position: posFields });
	return evalExpr(signal, ctx);
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
