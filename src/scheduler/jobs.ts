import { createChildLogger } from "../utils/logger.ts";
import { acquireLock, type LockCategory, releaseLock } from "./locks.ts";

const log = createChildLogger({ module: "scheduler-jobs" });

export type JobName =
	| "quote_refresh_uk"
	| "quote_refresh_us"
	| "quote_refresh_us_close"
	| "strategy_eval_uk"
	| "strategy_eval_us"
	| "news_poll"
	| "dispatch"
	| "daily_summary"
	| "weekly_digest"
	| "strategy_evolution"
	| "trade_review"
	| "pattern_analysis"
	| "earnings_calendar_sync"
	| "heartbeat"
	| "self_improvement"
	| "guardian_start"
	| "guardian_stop"
	| "live_evaluation"
	| "risk_guardian"
	| "risk_daily_reset"
	| "risk_weekly_reset"
	| "daily_tournament"
	| "missed_opportunity_daily"
	| "missed_opportunity_weekly"
	| "promotion_check";

const JOB_LOCK_CATEGORY: Record<JobName, LockCategory> = {
	quote_refresh_uk: "quotes_uk",
	quote_refresh_us: "quotes_us",
	quote_refresh_us_close: "quotes_us",
	strategy_eval_uk: "eval_uk",
	strategy_eval_us: "eval_us",
	news_poll: "news",
	dispatch: "dispatch",
	daily_summary: "analysis",
	weekly_digest: "analysis",
	strategy_evolution: "analysis",
	trade_review: "analysis",
	pattern_analysis: "analysis",
	earnings_calendar_sync: "maintenance",
	heartbeat: "maintenance",
	self_improvement: "analysis",
	guardian_start: "risk",
	guardian_stop: "risk",
	live_evaluation: "eval_us",
	risk_guardian: "risk",
	risk_daily_reset: "maintenance",
	risk_weekly_reset: "maintenance",
	daily_tournament: "analysis",
	missed_opportunity_daily: "analysis",
	missed_opportunity_weekly: "analysis",
	promotion_check: "analysis",
};

const JOB_TIMEOUT_MS = 10 * 60 * 1000;

export async function runJob(name: JobName): Promise<void> {
	const category = JOB_LOCK_CATEGORY[name];

	if (!acquireLock(category)) {
		const level = name === "trade_review" || name === "pattern_analysis" ? "warn" : "debug";
		log[level]({ job: name, category }, "Skipping — category lock held");
		return;
	}

	const start = Date.now();
	log.info({ job: name, category }, "Job starting");

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
		releaseLock(category);
	}
}

async function executeJob(name: JobName): Promise<void> {
	const TRADE_JOBS: JobName[] = ["strategy_eval_uk", "strategy_eval_us", "trade_review"];
	if (TRADE_JOBS.includes(name)) {
		const { isPaused } = await import("../monitoring/health.ts");
		if (isPaused()) {
			log.info({ job: name }, "Skipping — trading is paused");
			return;
		}
	}

	switch (name) {
		case "quote_refresh_uk": {
			const { refreshQuotesForAllCached } = await import("./quote-refresh.ts");
			await refreshQuotesForAllCached(["LSE"]);
			break;
		}

		case "quote_refresh_us": {
			const { refreshQuotesForAllCached } = await import("./quote-refresh.ts");
			await refreshQuotesForAllCached(["NASDAQ", "NYSE"]);
			break;
		}

		case "quote_refresh_us_close": {
			const { getCurrentSession } = await import("./sessions.ts");
			const session = getCurrentSession();
			if (session.name !== "us_close") {
				log.debug({ session: session.name }, "Not in us_close session — skipping");
				break;
			}
			const { refreshQuotesForAllCached } = await import("./quote-refresh.ts");
			await refreshQuotesForAllCached(["NASDAQ", "NYSE"]);
			break;
		}

		case "strategy_eval_uk": {
			const { runStrategyEvaluation } = await import("./strategy-eval-job.ts");
			await runStrategyEvaluation({ exchanges: ["LSE"] });
			break;
		}

		case "strategy_eval_us": {
			const { runStrategyEvaluation } = await import("./strategy-eval-job.ts");
			const { getCurrentSession } = await import("./sessions.ts");
			const session = getCurrentSession();
			await runStrategyEvaluation({
				exchanges: ["NASDAQ", "NYSE"],
				allowNewEntries: session.allowNewEntries,
			});
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

		case "self_improvement": {
			const { runSelfImproveJob } = await import("./self-improve-job.ts");
			await runSelfImproveJob();
			break;
		}

		case "guardian_start": {
			const { startGuardianJob } = await import("./guardian-job.ts");
			await startGuardianJob();
			break;
		}

		case "guardian_stop": {
			const { stopGuardianJob } = await import("./guardian-job.ts");
			await stopGuardianJob();
			break;
		}

		case "live_evaluation": {
			const { runLiveEvalJob } = await import("./live-eval-job.ts");
			await runLiveEvalJob();
			break;
		}

		case "risk_guardian": {
			const { runRiskGuardianJob } = await import("./risk-guardian-job.ts");
			await runRiskGuardianJob();
			break;
		}

		case "risk_daily_reset": {
			const { resetDailyState } = await import("../risk/guardian.ts");
			await resetDailyState();
			break;
		}

		case "risk_weekly_reset": {
			const { resetWeeklyState } = await import("../risk/guardian.ts");
			await resetWeeklyState();
			break;
		}

		case "daily_tournament": {
			const { runDailyTournaments } = await import("../evolution/tournament");
			await runDailyTournaments();
			break;
		}

		case "dispatch": {
			const { runDispatch } = await import("../strategy/dispatch.ts");
			await runDispatch();
			break;
		}

		case "missed_opportunity_daily": {
			const { runDailyMissedOpportunityReview } = await import("./missed-opportunity-job.ts");
			await runDailyMissedOpportunityReview();
			break;
		}

		case "missed_opportunity_weekly": {
			const { runWeeklyMissedOpportunityReview } = await import("./missed-opportunity-job.ts");
			await runWeeklyMissedOpportunityReview();
			break;
		}

		case "promotion_check": {
			const { runPromotionCheck } = await import("./promotion-job.ts");
			await runPromotionCheck();
			break;
		}
	}
}
