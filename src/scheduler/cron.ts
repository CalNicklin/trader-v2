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

	// Stubs for future phases — will be activated as phases are built
	// Weekly digest: 17:30 Friday
	// Strategy evolution: 20:00 Sunday
	// Trade review: 17:15 weekdays
	// Pattern analysis: 19:00 Wednesday + Friday

	log.info({ jobCount: tasks.length }, "Scheduler started");
}

export function stopScheduler(): void {
	for (const task of tasks) {
		task.stop();
	}
	tasks.length = 0;
	log.info("Scheduler stopped");
}
