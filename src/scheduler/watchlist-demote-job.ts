import { createChildLogger } from "../utils/logger.ts";
import { type DemotionResult, runDemotionSweep } from "../watchlist/demote.ts";

const log = createChildLogger({ module: "watchlist-demote-job" });

export interface WatchlistDemoteJobInput {
	now?: Date;
	exchanges?: readonly string[];
	cap?: number;
}

export async function runWatchlistDemoteJob(
	input: WatchlistDemoteJobInput = {},
): Promise<DemotionResult> {
	const now = input.now ?? new Date();
	const start = Date.now();
	const result = await runDemotionSweep(now, {
		exchanges: input.exchanges,
		cap: input.cap,
	});
	log.info(
		{
			job: "watchlist_demote",
			durationMs: Date.now() - start,
			scope: input.exchanges ?? "all",
			...result,
		},
		"Job completed",
	);
	return result;
}
