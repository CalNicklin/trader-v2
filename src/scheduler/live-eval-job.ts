import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "live-eval-job" });

export async function runLiveEvalJob(): Promise<void> {
	const config = getConfig();
	if (!config.LIVE_TRADING_ENABLED) {
		log.debug("Live trading disabled — skipping live eval");
		return;
	}

	try {
		const { runLiveExecutor } = await import("../live/executor.ts");
		const result = await runLiveExecutor();
		log.info(
			{
				strategiesEvaluated: result.strategiesEvaluated,
				tradesPlaced: result.tradesPlaced,
				errorCount: result.errors.length,
			},
			"Live eval job completed",
		);
	} catch (error) {
		log.error({ error }, "Live eval job failed");
	}
}
