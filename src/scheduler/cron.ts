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

	// Stubs for future phases
	// Weekly digest: 17:30 Friday

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

	log.info({ jobCount: tasks.length }, "Scheduler started");
}

export function stopScheduler(): void {
	for (const task of tasks) {
		task.stop();
	}
	tasks.length = 0;
	log.info("Scheduler stopped");
}
