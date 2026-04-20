import { sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";

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
