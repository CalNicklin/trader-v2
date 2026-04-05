import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "scheduler-jobs" });

export type JobName =
	| "quote_refresh"
	| "strategy_evaluation"
	| "daily_summary"
	| "weekly_digest"
	| "strategy_evolution"
	| "trade_review"
	| "pattern_analysis"
	| "earnings_calendar_sync"
	| "news_poll"
	| "heartbeat";

let jobRunning = false;
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function runJob(name: JobName): Promise<void> {
	if (jobRunning) {
		const level = name === "trade_review" || name === "pattern_analysis" ? "warn" : "debug";
		log[level]({ job: name }, "Skipping — previous job still running");
		return;
	}

	jobRunning = true;
	const start = Date.now();
	log.info({ job: name }, "Job starting");

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const jobPromise = executeJob(name);
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`Job ${name} timed out after ${JOB_TIMEOUT_MS / 60000}min`)),
			JOB_TIMEOUT_MS,
		);
	});

	try {
		await Promise.race([jobPromise, timeoutPromise]);
		log.info({ job: name, durationMs: Date.now() - start }, "Job completed");
		const { sendHeartbeat } = await import("../monitoring/heartbeat.ts");
		await sendHeartbeat(name).catch((err) =>
			log.warn({ err, job: name }, "Heartbeat failed (non-fatal)"),
		);
	} catch (error) {
		log.error({ job: name, error, durationMs: Date.now() - start }, "Job failed");
	} finally {
		clearTimeout(timeoutId);
		jobRunning = false;
	}
}

async function executeJob(name: JobName): Promise<void> {
	switch (name) {
		case "quote_refresh": {
			// Phase 1: refresh quotes for all symbols in quotes_cache
			const { refreshQuotesForAllCached } = await import("./quote-refresh.ts");
			await refreshQuotesForAllCached();
			break;
		}

		case "heartbeat": {
			const { sendEmail } = await import("../reporting/email.ts");
			const uptimeHrs = (process.uptime() / 3600).toFixed(1);
			await sendEmail({
				subject: `Heartbeat: Trader v2 alive — uptime ${uptimeHrs}h`,
				html: `<p>Trader v2 is running. Uptime: ${uptimeHrs} hours. Time: ${new Date().toISOString()}</p>`,
			});
			break;
		}

		case "strategy_evaluation": {
			const { runStrategyEvaluation } = await import("./strategy-eval-job.ts");
			await runStrategyEvaluation();
			break;
		}

		case "daily_summary": {
			const { runDailySummary } = await import("./daily-summary-job.ts");
			await runDailySummary();
			break;
		}

		case "news_poll": {
			const { runNewsPoll } = await import("./news-poll-job.ts");
			await runNewsPoll();
			break;
		}

		case "earnings_calendar_sync": {
			const { runEarningsSync } = await import("./earnings-sync-job.ts");
			await runEarningsSync();
			break;
		}

		case "strategy_evolution": {
			const { runEvolutionJob } = await import("./evolution-job.ts");
			await runEvolutionJob();
			break;
		}

		case "trade_review": {
			const { runTradeReviewJob } = await import("./trade-review-job.ts");
			await runTradeReviewJob();
			break;
		}
		case "pattern_analysis": {
			const { runPatternAnalysisJob } = await import("./pattern-analysis-job.ts");
			await runPatternAnalysisJob();
			break;
		}

		case "weekly_digest": {
			const { runWeeklyDigest } = await import("./weekly-digest-job.ts");
			await runWeeklyDigest();
			break;
		}
	}
}
