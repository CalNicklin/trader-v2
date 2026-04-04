import { runDailyTradeReview } from "../learning/trade-review.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "trade-review-job" });

export async function runTradeReviewJob(): Promise<void> {
	const result = await runDailyTradeReview();
	log.info(
		{ reviewed: result.reviewed, skippedBudget: result.skippedBudget },
		"Daily trade review complete",
	);
}
