import { and, eq, gt, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { dispatchDecisions } from "../db/schema.ts";

export interface DispatchDecisionRow {
	id: number;
	strategyId: number;
	symbol: string;
	action: "activate" | "skip";
	reasoning: string;
	source: "scheduled" | "catalyst";
	sourceNewsEventId: number | null;
	createdAt: string;
	expiresAt: string;
}

/**
 * Returns at most one decision per (strategy_id, symbol) pair.
 * Precedence:
 *   1. catalyst beats scheduled
 *   2. among same-source rows, newest createdAt wins
 * Expired rows are excluded.
 */
export async function getActiveDecisions(): Promise<DispatchDecisionRow[]> {
	const db = getDb();
	const nowIso = new Date().toISOString();
	const rows = await db.all<DispatchDecisionRow>(sql`
		SELECT id, strategy_id AS strategyId, symbol, action, reasoning,
		       source, source_news_event_id AS sourceNewsEventId,
		       created_at AS createdAt, expires_at AS expiresAt
		FROM (
			SELECT *,
			       ROW_NUMBER() OVER (
			         PARTITION BY strategy_id, symbol
			         ORDER BY CASE WHEN source = 'catalyst' THEN 0 ELSE 1 END,
			                  created_at DESC
			       ) AS rn
			FROM dispatch_decisions
			WHERE expires_at > ${nowIso}
		)
		WHERE rn = 1
	`);
	return rows;
}

export interface DispatchDecisionInput {
	strategyId: number;
	symbol: string;
	action: "activate" | "skip";
	reasoning: string;
}

export async function writeScheduledDecisions(
	decisions: DispatchDecisionInput[],
	expiresAt: string,
): Promise<void> {
	if (decisions.length === 0) return;
	const db = getDb();
	await db.insert(dispatchDecisions).values(
		decisions.map((d) => ({
			strategyId: d.strategyId,
			symbol: d.symbol,
			action: d.action,
			reasoning: d.reasoning,
			source: "scheduled" as const,
			sourceNewsEventId: null,
			expiresAt,
		})),
	);
}

export async function writeCatalystDecisions(
	decisions: DispatchDecisionInput[],
	expiresAt: string,
	newsEventId: number,
): Promise<void> {
	if (decisions.length === 0) return;
	const db = getDb();
	await db.insert(dispatchDecisions).values(
		decisions.map((d) => ({
			strategyId: d.strategyId,
			symbol: d.symbol,
			action: d.action,
			reasoning: d.reasoning,
			source: "catalyst" as const,
			sourceNewsEventId: newsEventId,
			expiresAt,
		})),
	);
}

/**
 * Marks every active scheduled row as expired. Catalyst rows are untouched.
 * Called at the start of each scheduled runDispatch so the evaluator's
 * getActiveDecisions() only sees the fresh scheduled set after a dispatch.
 */
export async function expireScheduledDecisions(): Promise<void> {
	const db = getDb();
	const nowIso = new Date().toISOString();
	await db
		.update(dispatchDecisions)
		.set({ expiresAt: nowIso })
		.where(and(eq(dispatchDecisions.source, "scheduled"), gt(dispatchDecisions.expiresAt, nowIso)));
}

/**
 * Deletes rows whose expiry was more than 24 hours ago. Returns row count.
 * Called nightly by the dispatch_decisions_cleanup scheduler job.
 */
export async function cleanupExpiredDecisions(): Promise<number> {
	const db = getDb();
	const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const doomed = await db
		.select({ id: dispatchDecisions.id })
		.from(dispatchDecisions)
		.where(lt(dispatchDecisions.expiresAt, cutoff));
	await db.delete(dispatchDecisions).where(lt(dispatchDecisions.expiresAt, cutoff));
	return doomed.length;
}
