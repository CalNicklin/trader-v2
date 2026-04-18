import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse, watchlist } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { DEFAULT_PROMOTION_TTL_HOURS, type PromotionReason } from "./constants.ts";

const log = createChildLogger({ module: "watchlist-promote" });

export interface PromoteInput {
	symbol: string;
	exchange: string;
	reason: PromotionReason;
	payload: unknown | null;
	ttlHours?: number;
}

export type PromoteResult =
	| { status: "inserted"; id: number }
	| { status: "updated"; id: number }
	| { status: "rejected_not_in_universe" };

export async function promoteToWatchlist(input: PromoteInput): Promise<PromoteResult> {
	const db = getDb();
	const ttlHours = input.ttlHours ?? DEFAULT_PROMOTION_TTL_HOURS;
	const now = new Date();
	const nowIso = now.toISOString();
	const newExpires = new Date(now.getTime() + ttlHours * 3600_000).toISOString();

	const inUniverse = db
		.select()
		.from(investableUniverse)
		.where(
			and(
				eq(investableUniverse.symbol, input.symbol),
				eq(investableUniverse.exchange, input.exchange),
				eq(investableUniverse.active, true),
			),
		)
		.get();
	if (!inUniverse) {
		log.warn(
			{ symbol: input.symbol, exchange: input.exchange, reason: input.reason },
			"Promotion rejected — symbol not in active investable universe",
		);
		return { status: "rejected_not_in_universe" };
	}

	const existing = db
		.select()
		.from(watchlist)
		.where(
			and(
				eq(watchlist.symbol, input.symbol),
				eq(watchlist.exchange, input.exchange),
				isNull(watchlist.demotedAt),
			),
		)
		.get();

	if (existing) {
		const reasons = new Set(existing.promotionReasons.split(","));
		reasons.add(input.reason);
		const mergedReasons = [...reasons].sort().join(",");

		const expiresAt =
			newExpires.localeCompare(existing.expiresAt) > 0 ? newExpires : existing.expiresAt;

		db.update(watchlist)
			.set({
				lastCatalystAt: nowIso,
				promotionReasons: mergedReasons,
				expiresAt,
			})
			.where(eq(watchlist.id, existing.id))
			.run();
		return { status: "updated", id: existing.id };
	}

	const result = db
		.insert(watchlist)
		.values({
			symbol: input.symbol,
			exchange: input.exchange,
			promotedAt: nowIso,
			lastCatalystAt: nowIso,
			promotionReasons: input.reason,
			expiresAt: newExpires,
		})
		.returning({ id: watchlist.id })
		.get();

	if (!result) throw new Error("watchlist insert returned nothing");
	return { status: "inserted", id: result.id };
}
