// src/risk/gate.ts

import { type PortfolioState, runAllTradeChecks, type TradeProposal } from "./limits.ts";
import { calcAtrPositionSize, type PositionSizeResult } from "./position-sizer.ts";

interface RiskGateInput {
	accountBalance: number;
	price: number;
	atr14: number;
	side: "BUY" | "SELL";
	exchange: string;
	sector: string | null;
	borrowFeeAnnualPct: number | null;
	openPositionCount: number;
	openPositionSectors: (string | null)[];
}

export interface RiskGateResult {
	allowed: boolean;
	reason?: string;
	sizing?: PositionSizeResult;
}

/**
 * Synchronous risk gate using only pure functions.
 * The caller is responsible for providing all state.
 * No DB calls — fully testable.
 */
export function checkTradeRiskGate(input: RiskGateInput): RiskGateResult {
	// 1. Calculate position size
	const sizing = calcAtrPositionSize({
		accountBalance: input.accountBalance,
		price: input.price,
		atr14: input.atr14,
		side: input.side,
		exchange: input.exchange,
	});

	if (sizing.skipped) {
		return { allowed: false, reason: sizing.skipReason };
	}

	// 2. Run all per-trade limit checks
	const portfolio: PortfolioState = {
		accountBalance: input.accountBalance,
		openPositions: input.openPositionSectors.map((s) => ({ sector: s })),
	};

	const proposal: TradeProposal = {
		side: input.side,
		riskAmount: sizing.riskAmount,
		sector: input.sector,
		borrowFeeAnnualPct: input.borrowFeeAnnualPct,
	};

	const limitCheck = runAllTradeChecks(portfolio, proposal);
	if (!limitCheck.allowed) {
		return { allowed: false, reason: limitCheck.reason };
	}

	return { allowed: true, sizing };
}
