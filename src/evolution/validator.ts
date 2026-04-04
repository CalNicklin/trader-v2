import type { MutationProposal, StrategyPerformance, ValidatedMutation } from "./types";

export const PARAMETER_RANGES: Record<string, { min: number; max: number }> = {
	position_size_pct: { min: 2, max: 25 },
	stop_loss_pct: { min: 1, max: 10 },
	hold_days: { min: 1, max: 20 },
	hold_bars: { min: 1, max: 20 },
	sentiment_threshold: { min: 0.1, max: 0.95 },
	tone_score_min: { min: 0.2, max: 0.9 },
	rsi_oversold: { min: 15, max: 45 },
	rsi_overbought: { min: 55, max: 85 },
	gap_threshold_pct: { min: 0.5, max: 5 },
	exit_target_pct: { min: 0.5, max: 10 },
	surprise_threshold: { min: 0.1, max: 0.9 },
};

const MAX_PARAMETERS = 5;
const MIN_DIVERSITY_DISTANCE = 0.05;

export function clampParameters(params: Record<string, number>): Record<string, number> {
	const result: Record<string, number> = {};
	for (const [key, value] of Object.entries(params)) {
		const range = PARAMETER_RANGES[key];
		if (range) {
			result[key] = Math.min(range.max, Math.max(range.min, value));
		} else {
			result[key] = value;
		}
	}
	return result;
}

function parameterDistance(a: Record<string, number>, b: Record<string, number>): number {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	let maxDelta = 0;
	for (const key of keys) {
		const aVal = a[key] ?? 0;
		const bVal = b[key] ?? 0;
		const delta = Math.abs(aVal - bVal) / Math.max(Math.abs(aVal), Math.abs(bVal), 1);
		if (delta > maxDelta) {
			maxDelta = delta;
		}
	}
	return maxDelta;
}

export function validateMutation(
	proposal: MutationProposal,
	parent: StrategyPerformance,
	existingStrategies: StrategyPerformance[],
): { valid: true; mutation: ValidatedMutation } | { valid: false; reason: string } {
	// 1. Clamp parameters
	const clamped = clampParameters(proposal.parameters);

	// 2. Reject if > 5 parameters
	if (Object.keys(clamped).length > MAX_PARAMETERS) {
		return {
			valid: false,
			reason: `Too many parameters: ${Object.keys(clamped).length} (max ${MAX_PARAMETERS})`,
		};
	}

	// 3. Reject new_variant if no signals provided
	if (proposal.type === "new_variant" && !proposal.signals) {
		return { valid: false, reason: "new_variant mutation must provide signals" };
	}

	// 4. Diversity check against all existing strategies
	for (const existing of existingStrategies) {
		const distance = parameterDistance(clamped, existing.parameters);
		if (distance < MIN_DIVERSITY_DISTANCE) {
			return {
				valid: false,
				reason: `Near-duplicate of existing strategy "${existing.name}" (distance ${distance.toFixed(4)} < ${MIN_DIVERSITY_DISTANCE})`,
			};
		}
	}

	// 5. Build parameterDiff
	const parameterDiff: Record<string, { from: number; to: number }> = {};
	for (const [key, value] of Object.entries(clamped)) {
		const parentValue = parent.parameters[key];
		if (parentValue === undefined || parentValue !== value) {
			parameterDiff[key] = { from: parentValue ?? 0, to: value };
		}
	}

	// 6. Return ValidatedMutation
	const mutation: ValidatedMutation = {
		parentId: proposal.parentId,
		type: proposal.type,
		name: proposal.name,
		description: proposal.description,
		parameters: clamped,
		signals: proposal.signals ?? parent.signals,
		universe: proposal.universe ?? parent.universe,
		parameterDiff,
	};

	return { valid: true, mutation };
}
