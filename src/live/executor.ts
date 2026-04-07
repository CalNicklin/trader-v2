import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { placeTrade } from "../broker/orders.ts";
import type { UnsettledTrade } from "../broker/settlement.ts";
import { getAvailableCash } from "../broker/settlement.ts";
import { getConfig } from "../config.ts";
import { getQuoteFromCache } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { agentLogs, graduationEvents, livePositions, liveTrades, paperTrades, strategies, strategyMetrics } from "../db/schema.ts";
import { checkTradeRiskGate } from "../risk/gate.ts";
import { isTradingHalted, isWeeklyDrawdownActive } from "../risk/guardian.ts";
import { buildSignalContext, type PositionFields, type QuoteFields } from "../strategy/context.ts";
import { evalExpr } from "../strategy/expr-eval.ts";
import { getIndicators, type SymbolIndicators } from "../strategy/historical.ts";
import { createChildLogger } from "../utils/logger.ts";
import { computeAllocations, type StrategyTier } from "./capital-allocator.ts";
import {
	type BehavioralComparison,
	checkBehavioralDivergence as checkDivergenceAgg,
	checkKillCriteria,
	checkTierBreach,
	checkTwoStrikeDemotion,
	type DemotionEvent,
	type StrategyLiveStats,
} from "../risk/demotion.ts";

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

	// Run demotion checks (non-fatal)
	try {
		await runDemotionChecks();
	} catch (err) {
		log.warn({ error: err }, "Demotion checks failed — non-fatal");
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
 * Retire a strategy: set status="retired", retiredAt=now, and record a "killed" graduation event.
 */
async function retireStrategy(
	db: ReturnType<typeof getDb>,
	strategyId: number,
	fromTier: string,
	reason: string,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(strategies)
		.set({ status: "retired", retiredAt: now })
		.where(eq(strategies.id, strategyId));

	await db.insert(graduationEvents).values({
		strategyId,
		event: "killed",
		fromTier,
		toTier: "retired",
		evidence: JSON.stringify({ reason }),
	});

	await db.insert(agentLogs).values({
		level: "ACTION" as const,
		phase: "demotion-checks",
		message: `Strategy ${strategyId} retired (killed): ${reason}`,
		data: JSON.stringify({ strategyId, fromTier, reason }),
	});

	log.warn({ strategyId, fromTier, reason }, "Strategy killed and retired");
}

/**
 * Run demotion checks for all graduated strategies.
 * Evaluates kill criteria, tier breaches, and behavioral divergence.
 * Records all actions to graduationEvents and agentLogs.
 */
export async function runDemotionChecks(): Promise<void> {
	const db = getDb();
	const now = new Date();

	// Fetch all graduated strategies
	const graduated = await db
		.select()
		.from(strategies)
		.where(inArray(strategies.status, LIVE_TIERS));

	for (const strategy of graduated) {
		try {
			// Fetch all filled live trades for this strategy
			const trades = await db
				.select()
				.from(liveTrades)
				.where(and(eq(liveTrades.strategyId, strategy.id), eq(liveTrades.status, "FILLED")))
				.orderBy(desc(liveTrades.filledAt));

			// Skip strategies with no live trades
			if (trades.length === 0) continue;

			// Compute kill criteria stats
			const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

			// Current loss streak = count of consecutive losses from most recent trades
			let currentLossStreak = 0;
			for (const trade of trades) {
				if ((trade.pnl ?? 0) < 0) {
					currentLossStreak++;
				} else {
					break;
				}
			}

			// Expected loss streak stats from historical data (simple binomial approximation)
			const winCount = trades.filter((t) => (t.pnl ?? 0) > 0).length;
			const lossRate = trades.length > 0 ? (trades.length - winCount) / trades.length : 0.5;
			const p = lossRate;
			const expectedLossStreakMean = p > 0 && p < 1 ? 1 / (1 - p) : 1;
			const expectedLossStreakStdDev =
				p > 0 && p < 1 ? Math.sqrt(p / ((1 - p) * (1 - p))) : 0.5;

			// Fetch demotion history from graduationEvents
			const demotionHistory = await db
				.select()
				.from(graduationEvents)
				.where(
					and(
						eq(graduationEvents.strategyId, strategy.id),
						eq(graduationEvents.event, "demoted"),
					),
				);
			const demotionDates = demotionHistory.map((e) => new Date(e.createdAt));

			const stats: StrategyLiveStats = {
				liveTradeCount: trades.length,
				totalPnl,
				currentLossStreak,
				expectedLossStreakMean,
				expectedLossStreakStdDev,
				demotionCount: demotionDates.length,
				demotionDates,
			};

			// Step 1: Check kill criteria
			const killResult = checkKillCriteria(stats, now);
			if (killResult.shouldKill) {
				await retireStrategy(db, strategy.id, strategy.status, killResult.reason!);
				continue;
			}

			// Step 2: Check tier breach
			// Get metrics for drawdown info and Sharpe fallback
			const [metrics] = await db
				.select()
				.from(strategyMetrics)
				.where(eq(strategyMetrics.strategyId, strategy.id));

			// Compute rolling 20-trade Sharpe from recent trades;
			// fall back to stored metrics sharpeRatio when stdDev is zero (all trades identical)
			const recent20 = trades.slice(0, 20);
			let rollingSharpe20 = metrics?.sharpeRatio ?? 0;
			if (recent20.length > 1) {
				const pnls = recent20.map((t) => t.pnl ?? 0);
				const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
				const variance =
					pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnls.length - 1);
				const stdDev = Math.sqrt(variance);
				if (stdDev > 0) {
					rollingSharpe20 = mean / stdDev;
				}
			}

			const currentDrawdownPct = metrics?.maxDrawdownPct ?? 0;

			// Get worst paper drawdown
			const paperTradeRows = await db
				.select({ pnl: paperTrades.pnl })
				.from(paperTrades)
				.where(eq(paperTrades.strategyId, strategy.id));
			const worstPaperDrawdownPct =
				paperTradeRows.length > 0
					? Math.abs(Math.min(0, ...paperTradeRows.map((t) => t.pnl ?? 0)))
					: 0;

			// Count consecutive negative Sharpe periods (approximate using rolling windows)
			const consecutiveNegativeSharpePeriods =
				metrics?.sharpeRatio != null && metrics.sharpeRatio < 0 ? 1 : 0;

			const tierBreachResult = checkTierBreach({
				tier: strategy.status as "probation" | "active" | "core",
				rollingSharpe20,
				currentDrawdownPct,
				worstPaperDrawdownPct,
				consecutiveNegativeSharpePeriods,
			});

			if (tierBreachResult.breached) {
				// Build demotion event history for two-strike logic
				const allEvents = await db
					.select()
					.from(graduationEvents)
					.where(eq(graduationEvents.strategyId, strategy.id));

				const demotionEvents: DemotionEvent[] = allEvents
					.filter((e) => e.event === "demoted" || e.event === "graduated")
					.map((e) => ({
						date: new Date(e.createdAt),
						type: (e.event === "demoted" ? "demotion" : "strike") as "strike" | "demotion",
					}));

				// Also include prior strike events
				const strikeEvents = allEvents
					.filter((e) => e.fromTier != null && e.toTier == null)
					.map((e) => ({ date: new Date(e.createdAt), type: "strike" as const }));

				const twoStrikeResult = checkTwoStrikeDemotion(
					[...demotionEvents, ...strikeEvents],
					now,
				);

				if (twoStrikeResult.action === "kill") {
					await retireStrategy(db, strategy.id, strategy.status, twoStrikeResult.reason);
				} else if (twoStrikeResult.action === "demote") {
					// Demote to paper status
					await db
						.update(strategies)
						.set({ status: "paper" })
						.where(eq(strategies.id, strategy.id));

					await db.insert(graduationEvents).values({
						strategyId: strategy.id,
						event: "demoted",
						fromTier: strategy.status,
						toTier: "paper",
						evidence: JSON.stringify({ reason: twoStrikeResult.reason }),
					});

					await db.insert(agentLogs).values({
						level: "ACTION" as const,
						phase: "demotion-checks",
						message: `Strategy ${strategy.id} demoted to paper: ${twoStrikeResult.reason}`,
						data: JSON.stringify({ strategyId: strategy.id, reason: twoStrikeResult.reason }),
					});

					log.warn(
						{ strategyId: strategy.id, reason: twoStrikeResult.reason },
						"Strategy demoted to paper",
					);
				} else {
					// first_strike: reduce capital by capitalMultiplier
					const multiplier = twoStrikeResult.capitalMultiplier ?? 0.5;
					const newBalance = strategy.virtualBalance * multiplier;

					await db
						.update(strategies)
						.set({ virtualBalance: newBalance })
						.where(eq(strategies.id, strategy.id));

					// Record strike event in graduation events
					await db.insert(graduationEvents).values({
						strategyId: strategy.id,
						event: "demoted",
						fromTier: strategy.status,
						toTier: strategy.status, // stays same tier but capital reduced
						evidence: JSON.stringify({
							reason: twoStrikeResult.reason,
							type: "first_strike",
							capitalMultiplier: multiplier,
						}),
					});

					await db.insert(agentLogs).values({
						level: "WARN" as const,
						phase: "demotion-checks",
						message: `Strategy ${strategy.id} first strike: capital reduced to ${(multiplier * 100).toFixed(0)}%`,
						data: JSON.stringify({
							strategyId: strategy.id,
							reason: twoStrikeResult.reason,
							newBalance,
						}),
					});

					log.warn(
						{ strategyId: strategy.id, newBalance, reason: twoStrikeResult.reason },
						"Strategy first strike — capital reduced",
					);
				}
			}

			// Step 3: Check behavioral divergence (log warning only, no auto-demote)
			const paperTradesFull = await db
				.select()
				.from(paperTrades)
				.where(eq(paperTrades.strategyId, strategy.id));

			if (paperTradesFull.length > 0 && trades.length > 0) {
				const paperAvgSlippage =
					paperTradesFull.reduce((s, t) => s + Math.abs(t.friction), 0) /
					paperTradesFull.length;
				const liveAvgSlippage =
					trades.reduce((s, t) => {
						const slip =
							t.fillPrice != null && t.limitPrice != null
								? Math.abs(t.fillPrice - t.limitPrice) / (t.limitPrice || 1)
								: 0;
						return s + slip;
					}, 0) / trades.length;

				const paperFilledCount = paperTradesFull.length;
				const liveFilledCount = trades.length;
				const paperFillRate =
					paperFilledCount > 0
						? paperFilledCount / (paperFilledCount + 1)
						: 0;
				const liveFillRate =
					liveFilledCount > 0
						? liveFilledCount / (liveFilledCount + 1)
						: 0;

				const paperAvgFriction =
					paperTradesFull.reduce((s, t) => s + t.friction, 0) / paperTradesFull.length;
				const liveAvgFriction =
					trades.reduce((s, t) => s + t.friction, 0) / trades.length;

				const comparison: BehavioralComparison = {
					paperAvgSlippage,
					liveAvgSlippage,
					paperFillRate,
					liveFillRate,
					paperAvgFriction,
					liveAvgFriction,
				};

				const divergenceResult = checkDivergenceAgg(comparison);
				if (divergenceResult.diverged) {
					log.warn(
						{ strategyId: strategy.id, reasons: divergenceResult.reasons },
						"Behavioral divergence detected between paper and live trading",
					);

					await db.insert(agentLogs).values({
						level: "WARN" as const,
						phase: "demotion-checks",
						message: `Strategy ${strategy.id} behavioral divergence: ${divergenceResult.reasons.join("; ")}`,
						data: JSON.stringify({
							strategyId: strategy.id,
							reasons: divergenceResult.reasons,
						}),
					});
				}
			}
		} catch (err) {
			log.error({ strategyId: strategy.id, error: err }, "Demotion check failed for strategy");
		}
	}
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
