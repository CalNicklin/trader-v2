import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse, universeSnapshots } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "universe-delta" });

export interface DeltaFlag {
	symbol: string;
	exchange: string;
	reason: string; // e.g. "halted", "delisted", "bankrupt"
}

export interface DeltaCheckInput {
	checker: () => Promise<DeltaFlag[]>;
	snapshotDate: string;
	exemptSymbols?: string[]; // `${symbol}:${exchange}` — open positions
}

export interface DeltaCheckResult {
	demoted: number;
}

export async function runDailyDeltaCheck(input: DeltaCheckInput): Promise<DeltaCheckResult> {
	const db = getDb();
	const exempt = new Set(input.exemptSymbols ?? []);
	const flags = await input.checker();

	let demoted = 0;
	const now = new Date().toISOString();
	for (const flag of flags) {
		const k = `${flag.symbol}:${flag.exchange}`;
		if (exempt.has(k)) {
			log.info({ symbol: flag.symbol, exchange: flag.exchange }, "Skipping exempt symbol");
			continue;
		}
		const result = await db
			.update(investableUniverse)
			.set({ active: false, lastRefreshed: now })
			.where(
				and(
					eq(investableUniverse.symbol, flag.symbol),
					eq(investableUniverse.exchange, flag.exchange),
					eq(investableUniverse.active, true),
				),
			)
			.returning({ id: investableUniverse.id });

		if (result.length > 0) {
			demoted++;
			await db.insert(universeSnapshots).values({
				snapshotDate: input.snapshotDate,
				symbol: flag.symbol,
				exchange: flag.exchange,
				action: "removed" as const,
				reason: flag.reason,
			});
		}
	}

	log.info({ flagged: flags.length, demoted }, "Daily delta check complete");
	return { demoted };
}
