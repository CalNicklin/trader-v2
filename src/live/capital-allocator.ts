export type StrategyTier = "probation" | "active" | "core";

/** Capital allocation percentages per tier (from spec Section 4) */
const TIER_ALLOCATION: Record<StrategyTier, number> = {
	probation: 0.1, // 10% of live capital
	active: 0.25, // 25% of live capital
	core: 0.5, // 50% of live capital
};

export interface StrategyAllocation {
	strategyId: number;
	tier: StrategyTier;
	allocatedCapital: number;
	maxPositionSize: number;
}

export interface AllocationInput {
	strategyId: number;
	tier: StrategyTier;
}

/**
 * Compute capital allocations for all graduated strategies.
 *
 * Rules:
 * - Each tier gets a fixed percentage of available capital
 * - If multiple strategies share a tier, they split that tier's allocation equally
 * - Total allocation is capped at 100% of available capital (excess strategies get reduced allocation)
 * - Max position size per strategy = 25% of its allocated capital (diversification)
 */
export function computeAllocations(
	strategies: ReadonlyArray<AllocationInput>,
	availableCash: number,
): StrategyAllocation[] {
	if (strategies.length === 0 || availableCash <= 0) return [];

	// Group strategies by tier
	const byTier = new Map<StrategyTier, AllocationInput[]>();
	for (const s of strategies) {
		const list = byTier.get(s.tier) ?? [];
		list.push(s);
		byTier.set(s.tier, list);
	}

	// Calculate raw allocations
	const allocations: StrategyAllocation[] = [];
	let totalRequested = 0;

	for (const [tier, tierStrategies] of byTier) {
		const tierPct = TIER_ALLOCATION[tier];
		const tierCapital = availableCash * tierPct;
		const perStrategy = tierCapital / tierStrategies.length;

		for (const s of tierStrategies) {
			totalRequested += perStrategy;
			allocations.push({
				strategyId: s.strategyId,
				tier: s.tier,
				allocatedCapital: perStrategy,
				maxPositionSize: perStrategy * 0.25,
			});
		}
	}

	// If total exceeds available cash, scale down proportionally
	if (totalRequested > availableCash) {
		const scale = availableCash / totalRequested;
		for (const a of allocations) {
			a.allocatedCapital = Math.round(a.allocatedCapital * scale * 100) / 100;
			a.maxPositionSize = Math.round(a.allocatedCapital * 0.25 * 100) / 100;
		}
	}

	return allocations;
}

/**
 * Get the allocation percentage for a specific tier.
 */
export function getTierAllocationPct(tier: StrategyTier): number {
	return TIER_ALLOCATION[tier];
}
