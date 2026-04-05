import { eq } from "drizzle-orm";
import type { IbkrPosition } from "../broker/account.ts";
import { getDb } from "../db/client.ts";
import { agentLogs, livePositions } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "reconciliation" });

export interface ReconciliationResult {
	inserted: number;
	deleted: number;
	discrepancies: string[];
}

/**
 * Reconcile DB positions with IBKR positions.
 * - Positions in IBKR but not DB → insert (orphaned from prior crash)
 * - Positions in DB but not IBKR → delete (phantom, closed while disconnected)
 */
export async function reconcilePositions(
	ibkrPositions: IbkrPosition[],
): Promise<ReconciliationResult> {
	const db = getDb();
	const result: ReconciliationResult = { inserted: 0, deleted: 0, discrepancies: [] };

	// Get all DB positions
	const dbPositions = await db.select().from(livePositions);

	// Build lookup sets
	const ibkrKeys = new Set(ibkrPositions.map((p) => `${p.symbol}:${p.exchange}`));
	const dbKeys = new Set(dbPositions.map((p) => `${p.symbol}:${p.exchange}`));

	// Insert orphaned IBKR positions
	for (const ibkrPos of ibkrPositions) {
		const key = `${ibkrPos.symbol}:${ibkrPos.exchange}`;
		if (!dbKeys.has(key)) {
			const msg = `Orphaned IBKR position: ${key} qty=${ibkrPos.quantity}`;
			result.discrepancies.push(msg);
			log.warn(msg);

			await db.insert(livePositions).values({
				symbol: ibkrPos.symbol,
				exchange: ibkrPos.exchange,
				currency: ibkrPos.currency,
				quantity: ibkrPos.quantity,
				avgCost: ibkrPos.avgCost,
			});
			result.inserted++;
		}
	}

	// Delete phantom DB positions
	for (const dbPos of dbPositions) {
		const key = `${dbPos.symbol}:${dbPos.exchange}`;
		if (!ibkrKeys.has(key)) {
			const msg = `Phantom DB position: ${key} qty=${dbPos.quantity} — removing`;
			result.discrepancies.push(msg);
			log.warn(msg);

			await db.delete(livePositions).where(eq(livePositions.id, dbPos.id));
			result.deleted++;
		}
	}

	// Log reconciliation
	if (result.inserted > 0 || result.deleted > 0) {
		await db.insert(agentLogs).values({
			level: "WARN" as const,
			phase: "reconciliation",
			message: `Position reconciliation: +${result.inserted} inserted, -${result.deleted} deleted`,
			data: JSON.stringify(result),
		});
	}

	log.info(
		{ inserted: result.inserted, deleted: result.deleted },
		"Position reconciliation complete",
	);

	return result;
}
