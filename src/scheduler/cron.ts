import cron, { type ScheduledTask } from "node-cron";
import { createChildLogger } from "../utils/logger.ts";
import { runJob } from "./jobs.ts";

const log = createChildLogger({ module: "scheduler" });

const tasks: ScheduledTask[] = [];

export function startScheduler(): void {
	// Quote refresh every 10 minutes during US + UK market hours (08:00-21:00 UK)
	tasks.push(
		cron.schedule("*/10 8-20 * * 1-5", () => runJob("quote_refresh"), {
			timezone: "Europe/London",
		}),
	);

	// Heartbeat at 07:00 weekdays
	tasks.push(
		cron.schedule("0 7 * * 1-5", () => runJob("heartbeat"), {
			timezone: "Europe/London",
		}),
	);

	// Strategy evaluation offset by 5 min from quote refresh to avoid global job lock collision
	tasks.push(
		cron.schedule("5,15,25,35,45,55 8-20 * * 1-5", () => runJob("strategy_evaluation"), {
			timezone: "Europe/London",
		}),
	);

	// Daily summary at 21:05 weekdays (after market close)
	tasks.push(
		cron.schedule("5 21 * * 1-5", () => runJob("daily_summary"), {
			timezone: "Europe/London",
		}),
	);

	// Strategy evolution — weekly Sunday 18:00
	tasks.push(
		cron.schedule("0 18 * * 0", () => runJob("strategy_evolution"), {
			timezone: "Europe/London",
		}),
	);

	// Daily trade review — 21:15 weekdays (after daily summary at 21:05)
	tasks.push(
		cron.schedule("15 21 * * 1-5", () => runJob("trade_review"), {
			timezone: "Europe/London",
		}),
	);

	// Pattern analysis — Tuesday and Friday at 21:30
	tasks.push(
		cron.schedule("30 21 * * 2,5", () => runJob("pattern_analysis"), {
			timezone: "Europe/London",
		}),
	);

	// Weekly digest: 17:30 Sunday
	tasks.push(
		cron.schedule("30 17 * * 0", () => runJob("weekly_digest"), {
			timezone: "Europe/London",
		}),
	);

	// News poll every 10 minutes during market hours, offset to :02 to avoid collision
	tasks.push(
		cron.schedule("2,12,22,32,42,52 8-20 * * 1-5", () => runJob("news_poll"), {
			timezone: "Europe/London",
		}),
	);

	// Earnings calendar sync at 06:00 weekdays (before market open)
	tasks.push(
		cron.schedule("0 6 * * 1-5", () => runJob("earnings_calendar_sync"), {
			timezone: "Europe/London",
		}),
	);

	// Self-improvement — weekly Sunday 19:00 (after evolution at 18:00)
	tasks.push(
		cron.schedule("0 19 * * 0", () => runJob("self_improvement"), {
			timezone: "Europe/London",
		}),
	);

	// Guardian start at 08:00 weekdays (starts the 60s interval loop)
	tasks.push(
		cron.schedule("0 8 * * 1-5", () => runJob("guardian_start"), {
			timezone: "Europe/London",
		}),
	);

	// Guardian stop at 21:00 weekdays (market close)
	tasks.push(
		cron.schedule("0 21 * * 1-5", () => runJob("guardian_stop"), {
			timezone: "Europe/London",
		}),
	);

	// Live strategy evaluation every 10 minutes during market hours, offset to :07
	tasks.push(
		cron.schedule("7,17,27,37,47,57 8-20 * * 1-5", () => runJob("live_evaluation"), {
			timezone: "Europe/London",
		}),
	);

	// Risk guardian every 10 minutes during market hours, offset to :04
	tasks.push(
		cron.schedule("4,14,24,34,44,54 8-20 * * 1-5", () => runJob("risk_guardian"), {
			timezone: "Europe/London",
		}),
	);

	// Daily risk state reset at 07:55 weekdays (before market open)
	tasks.push(
		cron.schedule("55 7 * * 1-5", () => runJob("risk_daily_reset"), {
			timezone: "Europe/London",
		}),
	);

	// Weekly risk state reset Monday at 07:50 (before daily reset)
	tasks.push(
		cron.schedule("50 7 * * 1", () => runJob("risk_weekly_reset"), {
			timezone: "Europe/London",
		}),
	);

	// Daily tournament — 21:45 weekdays (after trade review at 21:15)
	tasks.push(
		cron.schedule("45 21 * * 1-5", () => runJob("daily_tournament"), {
			timezone: "Europe/London",
		}),
	);

	// Dispatch — 3x daily at 09:00, 12:00, 15:00 UK time
	for (const hour of [9, 12, 15]) {
		tasks.push(
			cron.schedule(`0 ${hour} * * 1-5`, () => runJob("dispatch"), {
				timezone: "Europe/London",
			}),
		);
	}

	// Missed opportunity daily review — 21:20 weekdays (after trade review at 21:15)
	tasks.push(
		cron.schedule("20 21 * * 1-5", () => runJob("missed_opportunity_daily"), {
			timezone: "Europe/London",
		}),
	);

	// Missed opportunity weekly review — Wednesdays at 21:35
	tasks.push(
		cron.schedule("35 21 * * 3", () => runJob("missed_opportunity_weekly"), {
			timezone: "Europe/London",
		}),
	);

	log.info({ jobCount: tasks.length }, "Scheduler started");
}

export function stopScheduler(): void {
	for (const task of tasks) {
		task.stop();
	}
	tasks.length = 0;
	log.info("Scheduler stopped");
}
