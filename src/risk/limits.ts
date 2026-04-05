// src/risk/limits.ts
import {
	BORROW_FEE_CAP_ANNUAL_PCT,
	MAX_CONCURRENT_POSITIONS,
	MAX_CORRELATED_SECTOR_POSITIONS,
	MAX_SHORT_SIZE_RATIO,
	RISK_PER_TRADE_PCT,
} from "./constants.ts";

export interface LimitCheckResult {
	allowed: boolean;
	reason?: string;
}

export interface PositionInfo {
	sector: string | null;
}

export interface TradeProposal {
	side: "BUY" | "SELL";
	riskAmount: number;
	sector: string | null;
	borrowFeeAnnualPct: number | null;
}

export interface PortfolioState {
	accountBalance: number;
	openPositions: PositionInfo[];
}

export function checkRiskPerTrade(accountBalance: number, riskAmount: number): LimitCheckResult {
	const maxRisk = accountBalance * RISK_PER_TRADE_PCT;
	if (accountBalance <= 0) {
		return { allowed: false, reason: "Account balance is zero or negative" };
	}
	if (riskAmount > maxRisk) {
		return {
			allowed: false,
			reason: `Risk $${riskAmount.toFixed(2)} exceeds 1% of balance ($${maxRisk.toFixed(2)})`,
		};
	}
	return { allowed: true };
}

export function checkConcurrentPositions(currentOpenCount: number): LimitCheckResult {
	if (currentOpenCount >= MAX_CONCURRENT_POSITIONS) {
		return {
			allowed: false,
			reason: `Already at max concurrent positions (${currentOpenCount}/${MAX_CONCURRENT_POSITIONS})`,
		};
	}
	return { allowed: true };
}

export function checkMaxShortSize(
	accountBalance: number,
	riskAmount: number,
	side: "BUY" | "SELL",
): LimitCheckResult {
	if (side === "BUY") return { allowed: true };

	const maxLongRisk = accountBalance * RISK_PER_TRADE_PCT;
	const maxShortRisk = maxLongRisk * MAX_SHORT_SIZE_RATIO;

	if (riskAmount > maxShortRisk) {
		return {
			allowed: false,
			reason: `Short risk $${riskAmount.toFixed(2)} exceeds 75% of max long risk ($${maxShortRisk.toFixed(2)})`,
		};
	}
	return { allowed: true };
}

export function checkCorrelatedExposure(
	proposedSector: string | null,
	existingPositions: Pick<PositionInfo, "sector">[],
): LimitCheckResult {
	if (!proposedSector) return { allowed: true };

	const sectorCount = existingPositions.filter((p) => p.sector === proposedSector).length;

	if (sectorCount >= MAX_CORRELATED_SECTOR_POSITIONS) {
		return {
			allowed: false,
			reason: `Already ${sectorCount} positions in ${proposedSector} (max ${MAX_CORRELATED_SECTOR_POSITIONS})`,
		};
	}
	return { allowed: true };
}

export function checkBorrowFee(
	borrowFeeAnnualPct: number | null,
	side: "BUY" | "SELL",
): LimitCheckResult {
	if (side === "BUY") return { allowed: true };
	if (borrowFeeAnnualPct == null) return { allowed: true };

	if (borrowFeeAnnualPct >= BORROW_FEE_CAP_ANNUAL_PCT) {
		return {
			allowed: false,
			reason: `Borrow fee ${(borrowFeeAnnualPct * 100).toFixed(1)}% exceeds cap ${(BORROW_FEE_CAP_ANNUAL_PCT * 100).toFixed(1)}%`,
		};
	}
	return { allowed: true };
}

export function runAllTradeChecks(
	portfolio: PortfolioState,
	proposal: TradeProposal,
): LimitCheckResult {
	const checks = [
		checkRiskPerTrade(portfolio.accountBalance, proposal.riskAmount),
		checkConcurrentPositions(portfolio.openPositions.length),
		checkMaxShortSize(portfolio.accountBalance, proposal.riskAmount, proposal.side),
		checkCorrelatedExposure(proposal.sector, portfolio.openPositions),
		checkBorrowFee(proposal.borrowFeeAnnualPct, proposal.side),
	];

	for (const check of checks) {
		if (!check.allowed) return check;
	}
	return { allowed: true };
}
