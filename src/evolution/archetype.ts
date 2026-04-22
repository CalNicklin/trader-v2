/**
 * Strategy archetype classification + per-archetype risk floors (TRA-8).
 *
 * Strategies don't carry an explicit archetype column — archetype is inferred
 * from the strategy name convention established by the seeds (see
 * `src/strategy/seed.ts`). This module centralises that mapping so the
 * evolution validator (and any future graders) apply consistent floors.
 *
 * Forward-only: floors are enforced when new mutations spawn. Existing
 * strategies (notably 1 and 3) are NOT retro-patched — those trade off
 * wins and losses around a zero stop by design, and stopping them out at
 * 2% would close their winning MRVL/AVGO/AMZN earnings-drift trades.
 */

export type Archetype = "mean_reversion" | "earnings_drift" | "momentum" | "breakout";

/**
 * Per-archetype stop-loss floors in percent (matches insight-review rank #4).
 * Mutations proposing `stop_loss_pct` below the parent's archetype floor are
 * rejected by `validateMutation`.
 */
export const ARCHETYPE_STOP_LOSS_FLOOR: Record<Archetype, number> = {
	mean_reversion: 2,
	earnings_drift: 5,
	momentum: 3,
	breakout: 4,
};

// Ordered most-specific first so `momentum_breakout_v1` hits breakout (not
// momentum), and `earnings_drift` wins over any substring overlap.
const ARCHETYPE_PATTERNS: Array<{ archetype: Archetype; pattern: RegExp }> = [
	{ archetype: "earnings_drift", pattern: /earnings_drift/i },
	{ archetype: "breakout", pattern: /breakout/i },
	{ archetype: "momentum", pattern: /momentum/i },
	{ archetype: "mean_reversion", pattern: /_mr_|mean_reversion|fade|reversal/i },
];

export function inferArchetype(name: string): Archetype {
	for (const { archetype, pattern } of ARCHETYPE_PATTERNS) {
		if (pattern.test(name)) return archetype;
	}
	// Default to the most conservative floor if the name doesn't match any
	// known archetype — unrecognised strategies still get *some* protection.
	return "mean_reversion";
}
