import { eq, inArray } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import {
	closePaperPosition,
	getOpenPositionForSymbol,
	getOpenPositions,
	getSymbolsOnCooldown,
	type OpenPositionInput,
	openPaperPosition,
	WouldBreachCooldownError,
} from "../paper/manager.ts";
import { tickWouldBreachCap } from "../risk/basket-cap.ts";
import {
	HARD_STOP_LOSS_PCT,
	MAX_CONCURRENT_POSITIONS,
	STRATEGY_MIN_VIABLE_BALANCE,
} from "../risk/constants.ts";
import { checkTradeRiskGate } from "../risk/gate.ts";
import { isTradingHalted, isWeeklyDrawdownActive } from "../risk/guardian.ts";
import { createChildLogger } from "../utils/logger.ts";
import { buildSignalContext, type QuoteFields } from "./context.ts";
import { getActiveDecisions } from "./dispatch-store.ts";
import { evalExpr } from "./expr-eval.ts";
import type { SymbolIndicators } from "./historical.ts";
import { buildEffectiveUniverse, filterByLiquidity } from "./universe.ts";

const log = createChildLogger({ module: "evaluator" });

interface StrategyRow {
	id: number;
	name: string;
	parameters: string;
	signals: string | null;
	universe: string | null;
	status: string;
	virtualBalance: number;
}

interface SignalDef {
	entry_long?: string;
	entry_short?: string;
	exit?: string;
}

const NULL_QUOTE: QuoteFields = {
	last: null,
	bid: null,
	ask: null,
	volume: null,
	avgVolume: null,
	changePercent: null,
	newsSentiment: null,
	newsEarningsSurprise: null,
	newsGuidanceChange: null,
	newsManagementTone: null,
	newsRegulatoryRisk: null,
	newsAcquisitionLikelihood: null,
	newsCatalystType: null,
	newsExpectedMoveDuration: null,
};

const NULL_INDICATORS: SymbolIndicators = { rsi14: null, atr14: null, volume_ratio: null };

/**
 * Evaluate exit signals using only time-based conditions (hold_days).
 * Used when quote data is unavailable or position is on a symbol no longer in universe.
 * Price-based conditions (pnl_pct) will safely evaluate to false with null quote data.
 */
async function evaluateTimeBasedExit(
	strategy: StrategyRow,
	position: {
		id: number;
		symbol: string;
		exchange: string;
		entryPrice: number;
		openedAt: string;
		quantity: number;
		currentPrice: number | null;
	},
): Promise<void> {
	if (!strategy.signals) return;
	const signals: SignalDef = JSON.parse(strategy.signals);
	if (!signals.exit) return;

	const ctx = buildSignalContext({
		quote: NULL_QUOTE,
		indicators: NULL_INDICATORS,
		position: {
			entryPrice: position.entryPrice,
			openedAt: position.openedAt,
			quantity: position.quantity,
		},
	});

	if (evalExpr(signals.exit, ctx)) {
		const exitPrice = position.currentPrice ?? position.entryPrice;
		log.info(
			{ strategy: strategy.name, symbol: position.symbol, positionId: position.id, exitPrice },
			"Time-based exit fired (no quote data available)",
		);
		await closePaperPosition({
			positionId: position.id,
			strategyId: strategy.id,
			exitPrice,
			signalType: "exit",
			reasoning: `Time-based exit (no current quote): ${signals.exit}`,
		});
	}
}

export interface EvalInput {
	quote: QuoteFields;
	indicators: SymbolIndicators;
}

/**
 * Result of evaluating a single symbol:
 * - "none": no action (no signal fired, or gate rejected)
 * - "exited": an existing position was closed (already fired)
 * - "proposedEntry": an entry signal fired and passed the individual risk gate;
 *   the caller must decide whether to open it (subject to basket-cap check)
 */
export type SymbolEvalResult =
	| { kind: "none" }
	| { kind: "exited" }
	| { kind: "proposedEntry"; params: OpenPositionInput };

/**
 * Evaluate a strategy against a single symbol. Exits fire immediately; entries
 * are returned as proposals so the caller can enforce the tick-wide basket cap
 * (see `src/risk/basket-cap.ts`).
 */
export async function evaluateStrategyForSymbol(
	strategy: StrategyRow,
	symbol: string,
	exchange: string,
	input: EvalInput,
	riskState?: {
		openPositionCount: number;
		openPositionSectors: (string | null)[];
		weeklyDrawdownActive: boolean;
	},
): Promise<SymbolEvalResult> {
	if (!strategy.signals) return { kind: "none" };

	const signals: SignalDef = JSON.parse(strategy.signals);

	const openPosition = await getOpenPositionForSymbol(strategy.id, symbol, exchange);

	if (openPosition) {
		// ── Hard stop-loss kill floor (flat -5%) ─────────────────────────────
		if (input.quote.last != null && openPosition.entryPrice > 0) {
			const currentPrice = input.quote.last;
			const entryPrice = openPosition.entryPrice;
			const lossPct =
				openPosition.side === "BUY"
					? (entryPrice - currentPrice) / entryPrice
					: (currentPrice - entryPrice) / entryPrice;

			if (lossPct >= HARD_STOP_LOSS_PCT) {
				log.warn(
					{
						strategy: strategy.name,
						symbol,
						positionId: openPosition.id,
						side: openPosition.side,
						entryPrice,
						currentPrice,
						lossPct: lossPct.toFixed(4),
					},
					"Hard stop-loss kill floor triggered — force-closing position",
				);
				await closePaperPosition({
					positionId: openPosition.id,
					strategyId: strategy.id,
					exitPrice: currentPrice,
					signalType: "hard_stop",
					reasoning: `Hard stop-loss kill floor: position down ${(lossPct * 100).toFixed(2)}% (limit ${HARD_STOP_LOSS_PCT * 100}%)`,
				});
				return { kind: "exited" };
			}
		}

		if (signals.exit) {
			const ctx = buildSignalContext({
				quote: input.quote,
				indicators: input.indicators,
				position: {
					entryPrice: openPosition.entryPrice,
					openedAt: openPosition.openedAt,
					quantity: openPosition.quantity,
				},
			});

			if (evalExpr(signals.exit, ctx)) {
				log.info({ strategy: strategy.name, symbol, signal: "exit" }, "Exit signal fired");

				if (input.quote.last != null) {
					await closePaperPosition({
						positionId: openPosition.id,
						strategyId: strategy.id,
						exitPrice: input.quote.last,
						signalType: "exit",
						reasoning: `Exit signal: ${signals.exit}`,
					});
					return { kind: "exited" };
				}
			}
		}
		return { kind: "none" };
	}

	const ctx = buildSignalContext({
		quote: input.quote,
		indicators: input.indicators,
		position: null,
	});

	if (input.quote.last == null || input.quote.last <= 0) return { kind: "none" };
	const price = input.quote.last;

	if (signals.entry_long && evalExpr(signals.entry_long, ctx)) {
		const gateResult = checkTradeRiskGate({
			accountBalance: strategy.virtualBalance,
			price,
			atr14: input.indicators.atr14 ?? 0,
			side: "BUY",
			exchange,
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: riskState?.openPositionCount ?? 0,
			openPositionSectors: riskState?.openPositionSectors ?? [],
			weeklyDrawdownActive: riskState?.weeklyDrawdownActive,
		});

		if (!gateResult.allowed) {
			log.debug(
				{ strategy: strategy.name, symbol, reason: gateResult.reason },
				"Trade rejected by risk gate",
			);
			return { kind: "none" };
		}

		const { quantity, stopLossPrice } = gateResult.sizing!;
		if (quantity > 0) {
			log.info(
				{ strategy: strategy.name, symbol, signal: "entry_long", quantity, price, stopLossPrice },
				"Entry long signal fired (risk-gated) — proposing open",
			);
			return {
				kind: "proposedEntry",
				params: {
					strategyId: strategy.id,
					symbol,
					exchange,
					side: "BUY",
					price,
					quantity,
					signalType: "entry_long",
					reasoning: `Entry signal: ${signals.entry_long}`,
				},
			};
		}
	} else if (signals.entry_short && evalExpr(signals.entry_short, ctx)) {
		const gateResult = checkTradeRiskGate({
			accountBalance: strategy.virtualBalance,
			price,
			atr14: input.indicators.atr14 ?? 0,
			side: "SELL",
			exchange,
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: riskState?.openPositionCount ?? 0,
			openPositionSectors: riskState?.openPositionSectors ?? [],
			weeklyDrawdownActive: riskState?.weeklyDrawdownActive,
		});

		if (!gateResult.allowed) {
			log.debug(
				{ strategy: strategy.name, symbol, reason: gateResult.reason },
				"Trade rejected by risk gate",
			);
			return { kind: "none" };
		}

		const { quantity, stopLossPrice } = gateResult.sizing!;
		if (quantity > 0) {
			log.info(
				{
					strategy: strategy.name,
					symbol,
					signal: "entry_short",
					quantity,
					price,
					stopLossPrice,
				},
				"Entry short signal fired (risk-gated) — proposing open",
			);
			return {
				kind: "proposedEntry",
				params: {
					strategyId: strategy.id,
					symbol,
					exchange,
					side: "SELL",
					price,
					quantity,
					signalType: "entry_short",
					reasoning: `Entry signal: ${signals.entry_short}`,
				},
			};
		}
	}
	return { kind: "none" };
}

/**
 * Given a strategy's existing open count and a list of proposed entries collected
 * over a single evaluation tick, either fire all proposals (if the tick stays
 * within the basket cap) or log a warning and fire none. Returns the number
 * of positions actually opened.
 */
async function fireProposedEntriesWithBasketCap(
	strategy: StrategyRow,
	existingOpen: number,
	proposedEntries: OpenPositionInput[],
): Promise<number> {
	if (proposedEntries.length === 0) return 0;

	if (tickWouldBreachCap(existingOpen, proposedEntries.length)) {
		log.warn(
			{
				event: "basket_over_cap",
				strategy: strategy.name,
				strategyId: strategy.id,
				existingOpen,
				proposedCount: proposedEntries.length,
				symbols: proposedEntries.map((p) => p.symbol),
				cap: MAX_CONCURRENT_POSITIONS,
			},
			"Basket would breach MAX_CONCURRENT_POSITIONS — rejecting entire tick",
		);
		return 0;
	}

	let opened = 0;
	for (const params of proposedEntries) {
		try {
			await openPaperPosition(params);
			opened++;
		} catch (err) {
			if (err instanceof WouldBreachCooldownError) {
				log.info(
					{ strategy: strategy.name, symbol: params.symbol, err: err.message },
					"lse_cooldown_block",
				);
				continue;
			}
			log.error(
				{ strategy: strategy.name, symbol: params.symbol, error: err },
				"Error opening proposed paper position",
			);
		}
	}
	return opened;
}

export async function evaluateAllStrategies(
	getQuoteAndIndicators: (
		symbol: string,
		exchange: string,
	) => Promise<{ quote: QuoteFields; indicators: SymbolIndicators } | null>,
	options?: {
		exchanges?: Exchange[];
		allowNewEntries?: boolean;
	},
): Promise<void> {
	// Check if trading is halted before evaluating any strategies
	const haltStatus = await isTradingHalted();
	if (haltStatus.halted) {
		log.warn({ reason: haltStatus.reason }, "Trading halted — skipping strategy evaluation");
		return;
	}

	const db = getDb();

	const activeStrategies = await db.select().from(strategies).where(eq(strategies.status, "paper"));

	log.info({ count: activeStrategies.length }, "Evaluating paper strategies");

	// Check weekly drawdown state once for all strategies
	const weeklyDrawdownActive = await isWeeklyDrawdownActive();

	for (const strategy of activeStrategies) {
		if (!strategy.universe) continue;

		// Per-strategy circuit breaker: skip if balance is too depleted to trade meaningfully
		if (strategy.virtualBalance < STRATEGY_MIN_VIABLE_BALANCE) {
			log.warn(
				{
					strategy: strategy.name,
					balance: strategy.virtualBalance,
					min: STRATEGY_MIN_VIABLE_BALANCE,
				},
				"Strategy balance below minimum viable — skipping evaluation",
			);
			continue;
		}

		const rawUniverse: string[] = JSON.parse(strategy.universe);

		// Apply universe management: merge injections, cap at 50, filter liquidity
		const withInjections = await buildEffectiveUniverse(rawUniverse);
		const defaultExchange = "NASDAQ";
		const universe = await filterByLiquidity(withInjections, defaultExchange);

		// Apply exchange filter if provided (session-aware scheduling)
		const exchangeFiltered = options?.exchanges
			? universe.filter((spec) => {
					const ex = spec.includes(":") ? spec.split(":")[1]! : "NASDAQ";
					return options.exchanges!.includes(ex as Exchange);
				})
			: universe;

		// Gather open position state for this strategy
		const openPositions = await getOpenPositions(strategy.id);
		const riskState = {
			openPositionCount: openPositions.length,
			openPositionSectors: openPositions.map(() => null as string | null), // sector lookup not yet available
			weeklyDrawdownActive,
		};

		const openSymbols = new Set(openPositions.map((p) => `${p.symbol}:${p.exchange}`));
		const cooldownSymbols = await getSymbolsOnCooldown(strategy.id);

		const evaluatedSymbols = new Set<string>();
		const proposedEntries: OpenPositionInput[] = [];

		for (const symbolSpec of exchangeFiltered) {
			const [symbol, exchange] = symbolSpec.includes(":")
				? symbolSpec.split(":")
				: [symbolSpec, "NASDAQ"];

			evaluatedSymbols.add(`${symbol}:${exchange}`);

			// Skip symbols with no open position when entries are disallowed (us_close)
			if (options?.allowNewEntries === false && !openSymbols.has(`${symbol}:${exchange}`)) {
				continue;
			}

			// Skip symbols on cooldown after a recent losing exit (unless we have an open position to manage)
			if (
				cooldownSymbols.has(`${symbol}:${exchange}`) &&
				!openSymbols.has(`${symbol}:${exchange}`)
			) {
				log.debug({ strategy: strategy.name, symbol }, "Symbol on loss cooldown — skipping entry");
				continue;
			}

			const data = await getQuoteAndIndicators(symbol!, exchange!);
			if (!data) {
				// No quote data — still attempt time-based exit for open positions
				if (openSymbols.has(`${symbol}:${exchange}`)) {
					const pos = openPositions.find((p) => p.symbol === symbol && p.exchange === exchange);
					if (pos) {
						try {
							await evaluateTimeBasedExit(strategy, pos);
						} catch (error) {
							log.error(
								{ strategy: strategy.name, symbol, error },
								"Error in time-based exit fallback",
							);
						}
					}
				}
				continue;
			}

			try {
				const result = await evaluateStrategyForSymbol(
					strategy,
					symbol!,
					exchange!,
					data,
					riskState,
				);
				if (result.kind === "proposedEntry") {
					proposedEntries.push(result.params);
				}
			} catch (error) {
				log.error({ strategy: strategy.name, symbol, error }, "Error evaluating strategy");
			}
		}

		// Apply basket-cap check and fire (or reject) the tick's proposed entries
		await fireProposedEntriesWithBasketCap(strategy, openPositions.length, proposedEntries);

		// ── Exit-check orphaned positions (symbols no longer in universe) ────
		for (const pos of openPositions) {
			const key = `${pos.symbol}:${pos.exchange}`;
			if (evaluatedSymbols.has(key)) continue;

			log.info(
				{ strategy: strategy.name, symbol: pos.symbol, exchange: pos.exchange },
				"Evaluating orphaned position for exit (symbol not in current universe)",
			);

			const data = await getQuoteAndIndicators(pos.symbol, pos.exchange);
			try {
				if (data) {
					// Orphaned positions only exit; entries shouldn't fire here, but if they
					// somehow did we'd ignore the proposal (out-of-universe symbol).
					await evaluateStrategyForSymbol(strategy, pos.symbol, pos.exchange, data, riskState);
				} else {
					await evaluateTimeBasedExit(strategy, pos);
				}
			} catch (error) {
				log.error(
					{ strategy: strategy.name, symbol: pos.symbol, error },
					"Error evaluating orphaned position",
				);
			}
		}
	}

	// ── Graduated strategies (dispatch-filtered) ────────────────────────────
	const dispatchDecisions = await getActiveDecisions();

	const graduatedStatuses = ["probation", "active", "core"] as const;
	const graduatedStrategies = await db
		.select()
		.from(strategies)
		.where(inArray(strategies.status, [...graduatedStatuses]));

	if (graduatedStrategies.length === 0) {
		return;
	}

	// Build a set of activated strategy-symbol pairs from dispatch
	const activatedPairs = new Set(
		dispatchDecisions
			.filter((d) => d.action === "activate")
			.map((d) => `${d.strategyId}:${d.symbol}`),
	);

	// Build a set of explicitly skipped pairs
	const skippedPairs = new Set(
		dispatchDecisions.filter((d) => d.action === "skip").map((d) => `${d.strategyId}:${d.symbol}`),
	);

	log.info(
		{
			graduated: graduatedStrategies.length,
			activated: activatedPairs.size,
			skipped: skippedPairs.size,
		},
		"Evaluating graduated strategies with dispatch filtering",
	);

	for (const strategy of graduatedStrategies) {
		if (!strategy.universe) continue;
		const rawUniverse: string[] = JSON.parse(strategy.universe);
		const withInjections = await buildEffectiveUniverse(rawUniverse);
		const defaultExchange = "NASDAQ";
		const filteredUniverse = await filterByLiquidity(withInjections, defaultExchange);

		// Apply exchange filter if provided (session-aware scheduling)
		const exchangeFilteredGrad = options?.exchanges
			? filteredUniverse.filter((spec) => {
					const ex = spec.includes(":") ? spec.split(":")[1]! : "NASDAQ";
					return options.exchanges!.includes(ex as Exchange);
				})
			: filteredUniverse;

		const openPositions = await getOpenPositions(strategy.id);
		const riskState = {
			openPositionCount: openPositions.length,
			openPositionSectors: openPositions.map(() => null as string | null),
			weeklyDrawdownActive,
		};

		const openSymbolsGrad = new Set(openPositions.map((p) => `${p.symbol}:${p.exchange}`));
		const cooldownSymbolsGrad = await getSymbolsOnCooldown(strategy.id);

		const evaluatedSymbolsGrad = new Set<string>();
		const proposedEntriesGrad: OpenPositionInput[] = [];

		for (const symbolSpec of exchangeFilteredGrad) {
			const [symbol, exchange] = symbolSpec.includes(":")
				? symbolSpec.split(":")
				: [symbolSpec, "NASDAQ"];

			evaluatedSymbolsGrad.add(`${symbol}:${exchange}`);

			// Skip symbols with no open position when entries are disallowed (us_close)
			if (options?.allowNewEntries === false && !openSymbolsGrad.has(`${symbol}:${exchange}`)) {
				continue;
			}

			// Skip symbols on cooldown after a recent losing exit
			if (
				cooldownSymbolsGrad.has(`${symbol}:${exchange}`) &&
				!openSymbolsGrad.has(`${symbol}:${exchange}`)
			) {
				log.debug({ strategy: strategy.name, symbol }, "Symbol on loss cooldown — skipping entry");
				continue;
			}

			const pairKey = `${strategy.id}:${symbol}`;

			// Skip if dispatch explicitly said skip
			if (skippedPairs.has(pairKey)) {
				log.debug({ strategy: strategy.name, symbol }, "Skipped by dispatch");
				continue;
			}

			// If dispatch had opinions on this strategy but didn't activate this symbol, skip
			const dispatchHasOpinionOnStrategy = dispatchDecisions.some(
				(d) => d.strategyId === strategy.id,
			);
			if (dispatchHasOpinionOnStrategy && !activatedPairs.has(pairKey)) {
				continue;
			}

			const data = await getQuoteAndIndicators(symbol!, exchange!);
			if (!data) {
				// No quote data — still attempt time-based exit for open positions
				if (openSymbolsGrad.has(`${symbol}:${exchange}`)) {
					const pos = openPositions.find((p) => p.symbol === symbol && p.exchange === exchange);
					if (pos) {
						try {
							await evaluateTimeBasedExit(strategy, pos);
						} catch (error) {
							log.error(
								{ strategy: strategy.name, symbol, error },
								"Error in time-based exit fallback",
							);
						}
					}
				}
				continue;
			}

			try {
				const result = await evaluateStrategyForSymbol(
					strategy,
					symbol!,
					exchange!,
					data,
					riskState,
				);
				if (result.kind === "proposedEntry") {
					proposedEntriesGrad.push(result.params);
				}
			} catch (error) {
				log.error(
					{ strategy: strategy.name, symbol, error },
					"Error evaluating graduated strategy",
				);
			}
		}

		// Apply basket-cap check and fire (or reject) the tick's proposed entries
		await fireProposedEntriesWithBasketCap(strategy, openPositions.length, proposedEntriesGrad);

		// ── Exit-check orphaned positions (symbols no longer in universe) ────
		for (const pos of openPositions) {
			const key = `${pos.symbol}:${pos.exchange}`;
			if (evaluatedSymbolsGrad.has(key)) continue;

			log.info(
				{ strategy: strategy.name, symbol: pos.symbol, exchange: pos.exchange },
				"Evaluating orphaned graduated position for exit",
			);

			const data = await getQuoteAndIndicators(pos.symbol, pos.exchange);
			try {
				if (data) {
					await evaluateStrategyForSymbol(strategy, pos.symbol, pos.exchange, data, riskState);
				} else {
					await evaluateTimeBasedExit(strategy, pos);
				}
			} catch (error) {
				log.error(
					{ strategy: strategy.name, symbol: pos.symbol, error },
					"Error evaluating orphaned graduated position",
				);
			}
		}
	}
}
