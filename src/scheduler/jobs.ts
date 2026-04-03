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
		log.debug({ job: name }, "Skipping — previous job still running");
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

		// Stubs for future phases — log and return
		case "weekly_digest":
		case "strategy_evolution":
		case "trade_review":
		case "pattern_analysis":
			log.info({ job: name }, "Job not yet implemented (future phase)");
			break;
	}
}
