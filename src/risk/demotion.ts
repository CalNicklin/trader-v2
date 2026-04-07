// src/risk/demotion.ts
import {
	BEHAVIORAL_DIVERGENCE_THRESHOLD,
	CAPITAL_REDUCTION_FIRST_STRIKE,
	KILL_DEMOTION_WINDOW_DAYS,
	KILL_DEMOTIONS_IN_WINDOW,
	KILL_LOSS_STREAK_SD,
	KILL_MAX_LIVE_TRADES,
	TWO_STRIKE_WINDOW_DAYS,
} from "./constants.ts";

export interface DemotionEvent {
	date: Date;
	type: "strike" | "demotion";
}

export interface TwoStrikeResult {
	action: "first_strike" | "demote" | "kill";
	capitalMultiplier?: number;
	reason: string;
}

export interface StrategyLiveStats {
	liveTradeCount: number;
	totalPnl: number;
	currentLossStreak: number;
	expectedLossStreakMean: number;
	expectedLossStreakStdDev: number;
	demotionCount: number;
	demotionDates: Date[];
}

export interface KillResult {
	shouldKill: boolean;
	reason?: string;
}

export interface BehavioralComparison {
	paperAvgSlippage: number;
	liveAvgSlippage: number;
	paperFillRate: number;
	liveFillRate: number;
	paperAvgFriction: number;
	liveAvgFriction: number;
}

export interface DivergenceResult {
	diverged: boolean;
	reasons: string[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function checkTwoStrikeDemotion(recentEvents: DemotionEvent[], now: Date): TwoStrikeResult {
	const windowMs = TWO_STRIKE_WINDOW_DAYS * MS_PER_DAY;
	const killWindowMs = KILL_DEMOTION_WINDOW_DAYS * MS_PER_DAY;

	// Check if already demoted twice within 60 days -> kill
	const recentDemotions = recentEvents.filter(
		(e) => e.type === "demotion" && now.getTime() - e.date.getTime() <= killWindowMs,
	);
	if (recentDemotions.length >= KILL_DEMOTIONS_IN_WINDOW) {
		return {
			action: "kill",
			reason: `Demoted ${recentDemotions.length} times within ${KILL_DEMOTION_WINDOW_DAYS} days — permanent retirement`,
		};
	}

	// Check for recent strike within 30 days
	const recentStrikes = recentEvents.filter(
		(e) => e.type === "strike" && now.getTime() - e.date.getTime() <= windowMs,
	);
	if (recentStrikes.length > 0) {
		return {
			action: "demote",
			reason: `Second breach within ${TWO_STRIKE_WINDOW_DAYS} days — demoting to Paper`,
		};
	}

	// First strike
	return {
		action: "first_strike",
		capitalMultiplier: CAPITAL_REDUCTION_FIRST_STRIKE,
		reason: `First breach — capital reduced to ${CAPITAL_REDUCTION_FIRST_STRIKE * 100}%`,
	};
}

export function checkKillCriteria(stats: StrategyLiveStats, now: Date): KillResult {
	// 1. Loss streak exceeding 3 SD
	const streakThreshold =
		stats.expectedLossStreakMean + KILL_LOSS_STREAK_SD * stats.expectedLossStreakStdDev;
	if (stats.currentLossStreak > streakThreshold) {
		return {
			shouldKill: true,
			reason: `Loss streak ${stats.currentLossStreak} exceeds 3 SD threshold (${streakThreshold.toFixed(1)})`,
		};
	}

	// 2. Not profitable after 60 live trades
	if (stats.liveTradeCount >= KILL_MAX_LIVE_TRADES && stats.totalPnl <= 0) {
		return {
			shouldKill: true,
			reason: `Not profitable after ${stats.liveTradeCount} live trades (P&L: $${stats.totalPnl.toFixed(2)})`,
		};
	}

	// 3. Demoted twice within 60 days
	const killWindowMs = KILL_DEMOTION_WINDOW_DAYS * MS_PER_DAY;
	const recentDemotions = stats.demotionDates.filter(
		(d) => now.getTime() - d.getTime() <= killWindowMs,
	);
	if (recentDemotions.length >= KILL_DEMOTIONS_IN_WINDOW) {
		return {
			shouldKill: true,
			reason: `Demoted twice within ${KILL_DEMOTION_WINDOW_DAYS} days`,
		};
	}

	return { shouldKill: false };
}

export interface TierBreachInput {
	tier: "probation" | "active" | "core";
	rollingSharpe20: number;
	currentDrawdownPct: number;
	worstPaperDrawdownPct: number;
	consecutiveNegativeSharpePeriods: number;
}

export interface TierBreachResult {
	breached: boolean;
	reason?: string;
}

const DRAWDOWN_BREACH_MULT = 1.5;
const CONSECUTIVE_NEG_SHARPE_PERIODS = 2;

export function checkTierBreach(input: TierBreachInput): TierBreachResult {
	if (input.tier === "probation") {
		if (input.rollingSharpe20 < 0) {
			return { breached: true, reason: `Sharpe (${input.rollingSharpe20.toFixed(2)}) is negative on probation` };
		}
		return { breached: false };
	}

	// active or core
	if (input.currentDrawdownPct > input.worstPaperDrawdownPct * DRAWDOWN_BREACH_MULT) {
		return {
			breached: true,
			reason: `Drawdown ${input.currentDrawdownPct}% exceeds ${DRAWDOWN_BREACH_MULT}x worst paper drawdown (${input.worstPaperDrawdownPct}%)`,
		};
	}

	if (input.consecutiveNegativeSharpePeriods >= CONSECUTIVE_NEG_SHARPE_PERIODS) {
		return {
			breached: true,
			reason: `${input.consecutiveNegativeSharpePeriods} consecutive negative Sharpe periods`,
		};
	}

	return { breached: false };
}

export function checkBehavioralDivergence(comparison: BehavioralComparison): DivergenceResult {
	const reasons: string[] = [];
	const threshold = BEHAVIORAL_DIVERGENCE_THRESHOLD;

	const checkDeviation = (label: string, paperVal: number, liveVal: number) => {
		if (paperVal === 0) {
			if (liveVal > 0) {
				reasons.push(
					`${label}: paper=0, live=${liveVal.toFixed(4)} — cannot compute ratio, flagging`,
				);
			}
			return;
		}

		const deviation = Math.abs(liveVal - paperVal) / Math.abs(paperVal);
		if (deviation > threshold) {
			reasons.push(
				`${label}: paper=${paperVal.toFixed(4)}, live=${liveVal.toFixed(4)}, deviation=${(deviation * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}%`,
			);
		}
	};

	checkDeviation("Slippage", comparison.paperAvgSlippage, comparison.liveAvgSlippage);
	checkDeviation("Fill rate", comparison.paperFillRate, comparison.liveFillRate);
	checkDeviation("Friction", comparison.paperAvgFriction, comparison.liveAvgFriction);

	return { diverged: reasons.length > 0, reasons };
}
