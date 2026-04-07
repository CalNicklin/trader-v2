import { createChildLogger } from "../utils/logger.ts";

const _log = createChildLogger({ module: "promotion" });

// ── Thresholds ──────────────────────────────────────────────────────────────

const PROBATION_TO_ACTIVE_MIN_TRADES = 30;
const ACTIVE_TO_CORE_MIN_TRADES = 100;
const ACTIVE_TO_CORE_MIN_SHARPE = 0.5;
const METRIC_DEGRADATION_TOLERANCE = 0.2; // 20%
const CORE_NO_DEMOTION_DAYS = 60;

// ── Types ───────────────────────────────────────────────────────────────────

export interface LiveTrade {
	pnl: number | null;
	fillPrice: number | null;
}

export interface LiveMetricsSummary {
	sampleSize: number;
	winRate: number | null;
	expectancy: number | null;
	profitFactor: number | null;
	sharpeRatio: number | null;
}

export interface ComparableMetrics {
	sharpeRatio: number | null;
	winRate: number | null;
	profitFactor: number | null;
}

export interface DegradationResult {
	degraded: boolean;
	reasons: string[];
}

export interface PromotionInput {
	currentTier: "probation" | "active" | "core";
	liveTradeCount: number;
	hasActiveStrikes: boolean;
	paperMetrics: ComparableMetrics;
	liveMetrics: ComparableMetrics;
	liveSharpe: number;
	liveExpectancy: number;
	recentDemotionCount: number;
	diverged: boolean;
}

export interface PromotionResult {
	eligible: boolean;
	nextTier?: "active" | "core";
	reasons: string[];
}

// ── Live Metrics Computation ────────────────────────────────────────────────

export function computeLiveMetrics(trades: LiveTrade[]): LiveMetricsSummary {
	const filled = trades.filter((t) => t.pnl != null);
	if (filled.length === 0) {
		return {
			sampleSize: 0,
			winRate: null,
			expectancy: null,
			profitFactor: null,
			sharpeRatio: null,
		};
	}

	const pnls = filled.map((t) => t.pnl!);
	const wins = pnls.filter((p) => p > 0);
	const losses = pnls.filter((p) => p < 0);

	const winRate = wins.length / pnls.length;
	const expectancy = pnls.reduce((a, b) => a + b, 0) / pnls.length;

	const grossProfit = wins.reduce((a, b) => a + b, 0);
	const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
	const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

	// Annualized Sharpe (approximate: assume daily returns, 252 trading days)
	const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
	const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / pnls.length;
	const stdDev = Math.sqrt(variance);
	const sharpeRatio = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

	return { sampleSize: filled.length, winRate, expectancy, profitFactor, sharpeRatio };
}

// ── Metric Degradation Check ────────────────────────────────────────────────

export function checkMetricDegradation(
	paper: ComparableMetrics,
	live: ComparableMetrics,
	tolerance: number = METRIC_DEGRADATION_TOLERANCE,
): DegradationResult {
	const reasons: string[] = [];

	const check = (label: string, paperVal: number | null, liveVal: number | null) => {
		if (paperVal == null || liveVal == null) return; // skip if either is missing
		if (paperVal === 0) return; // can't compute ratio
		const degradation = (paperVal - liveVal) / Math.abs(paperVal);
		if (degradation > tolerance) {
			reasons.push(
				`${label}: paper=${paperVal.toFixed(3)}, live=${liveVal.toFixed(3)}, degraded ${(degradation * 100).toFixed(1)}%`,
			);
		}
	};

	check("Sharpe", paper.sharpeRatio, live.sharpeRatio);
	check("Win rate", paper.winRate, live.winRate);
	check("Profit factor", paper.profitFactor, live.profitFactor);

	return { degraded: reasons.length > 0, reasons };
}

// ── Promotion Eligibility ───────────────────────────────────────────────────

export function checkPromotionEligibility(input: PromotionInput): PromotionResult {
	const reasons: string[] = [];

	if (input.currentTier === "core") {
		return { eligible: false, reasons: ["Already at highest tier"] };
	}

	// Common gates
	if (input.hasActiveStrikes) {
		reasons.push("Active demotion strike");
	}
	if (input.diverged) {
		reasons.push("Behavioral divergence detected");
	}

	if (input.currentTier === "probation") {
		if (input.liveTradeCount < PROBATION_TO_ACTIVE_MIN_TRADES) {
			reasons.push(
				`Insufficient live trades: ${input.liveTradeCount} < ${PROBATION_TO_ACTIVE_MIN_TRADES}`,
			);
		}

		const degradation = checkMetricDegradation(input.paperMetrics, input.liveMetrics);
		if (degradation.degraded) {
			reasons.push(...degradation.reasons);
		}

		if (reasons.length === 0) {
			return { eligible: true, nextTier: "active", reasons: [] };
		}
		return { eligible: false, reasons };
	}

	// active → core
	if (input.liveTradeCount < ACTIVE_TO_CORE_MIN_TRADES) {
		reasons.push(
			`Insufficient live trades: ${input.liveTradeCount} < ${ACTIVE_TO_CORE_MIN_TRADES}`,
		);
	}
	if (input.liveSharpe < ACTIVE_TO_CORE_MIN_SHARPE) {
		reasons.push(`Sharpe too low: ${input.liveSharpe.toFixed(2)} < ${ACTIVE_TO_CORE_MIN_SHARPE}`);
	}
	if (input.liveExpectancy <= 0) {
		reasons.push(`Expectancy not positive: ${input.liveExpectancy.toFixed(2)}`);
	}
	if (input.recentDemotionCount > 0) {
		reasons.push(`${input.recentDemotionCount} demotion(s) in last ${CORE_NO_DEMOTION_DAYS} days`);
	}

	if (reasons.length === 0) {
		return { eligible: true, nextTier: "core", reasons: [] };
	}
	return { eligible: false, reasons };
}
