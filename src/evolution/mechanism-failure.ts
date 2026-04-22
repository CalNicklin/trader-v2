import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../db/client";
import { tradeInsights } from "../db/schema";

/**
 * Mechanism-failure tag gating (TRA-10).
 *
 * A "mechanism failure" tag describes a trade that failed because the
 * strategy's *mechanism* was wrong (ignored a catalyst, misread a filter,
 * misjudged the regime) — not because of timing or sizing. When a parent
 * strategy accumulates these at a high enough rate, spawning mutations from
 * it tends to inherit the defect rather than fix it.
 */

export const MECHANISM_FAILURE_TAGS: ReadonlySet<string> = new Set([
	"filter_failure",
	"catalyst_ignored",
	"fundamental_gap",
	"regime_mismatch",
]);

/** Fraction of in-window trade_reviews that must carry a mechanism-failure tag before we block spawn. */
export const MECHANISM_FAILURE_RATE_THRESHOLD = 0.5;

/** Minimum number of non-quarantined trade_review rows before the gate engages. */
export const MECHANISM_FAILURE_MIN_REVIEWS = 4;

/** Rolling window for computing the rate. */
export const MECHANISM_FAILURE_LOOKBACK_DAYS = 30;

export interface MechanismFailureStats {
	totalReviews: number;
	failureRate: number;
}

function hasMechanismFailureTag(tagsJson: string | null): boolean {
	if (!tagsJson) return false;
	try {
		const parsed = JSON.parse(tagsJson);
		if (!Array.isArray(parsed)) return false;
		return parsed.some((t) => typeof t === "string" && MECHANISM_FAILURE_TAGS.has(t));
	} catch {
		return false;
	}
}

export async function getMechanismFailureStats(
	strategyId: number,
	now: Date = new Date(),
): Promise<MechanismFailureStats> {
	const db = getDb();
	const cutoff = new Date(
		now.getTime() - MECHANISM_FAILURE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();

	const rows = await db
		.select({ tags: tradeInsights.tags })
		.from(tradeInsights)
		.where(
			and(
				eq(tradeInsights.strategyId, strategyId),
				eq(tradeInsights.insightType, "trade_review"),
				eq(tradeInsights.quarantined, 0),
				gte(tradeInsights.createdAt, cutoff),
			),
		);

	const totalReviews = rows.length;
	if (totalReviews === 0) {
		return { totalReviews: 0, failureRate: 0 };
	}
	const failures = rows.filter((r) => hasMechanismFailureTag(r.tags)).length;
	return { totalReviews, failureRate: failures / totalReviews };
}
