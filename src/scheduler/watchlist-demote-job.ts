import { createChildLogger } from "../utils/logger.ts";
import { type DemotionResult, runDemotionSweep } from "../watchlist/demote.ts";

const log = createChildLogger({ module: "watchlist-demote-job" });

export async function runWatchlistDemoteJob(input: { now?: Date } = {}): Promise<DemotionResult> {
	const now = input.now ?? new Date();
	log.info({ job: "watchlist_demote" }, "Job starting");
	const start = Date.now();
	const result = await runDemotionSweep(now);
	log.info({ job: "watchlist_demote", durationMs: Date.now() - start, ...result }, "Job completed");
	return result;
}
