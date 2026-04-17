import cron, { type ScheduledTask } from "node-cron";
import { createChildLogger } from "../utils/logger.ts";
import { runJob } from "./jobs.ts";

const log = createChildLogger({ module: "scheduler" });

const tasks: ScheduledTask[] = [];

export function startScheduler(): void {
	// ── Per-market quote refresh ────────────────────────────────────────
	tasks.push(
		cron.schedule("*/10 8-16 * * 1-5", () => runJob("quote_refresh_uk"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("5,15,25,35,45,55 14-20 * * 1-5", () => runJob("quote_refresh_us"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("*/5 21 * * 1-5", () => runJob("quote_refresh_us_close"), {
			timezone: "Europe/London",
		}),
	);

	// ── Per-market strategy evaluation ──────────────────────────────────
	tasks.push(
		cron.schedule("3,13,23,33,43,53 8-16 * * 1-5", () => runJob("strategy_eval_uk"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("8,18,28,38,48,58 14-20 * * 1-5", () => runJob("strategy_eval_us"), {
			timezone: "Europe/London",
		}),
	);

	// ── News polling ────────────────────────────────────────────────────
	tasks.push(
		cron.schedule("*/10 6-20 * * 1-5", () => runJob("news_poll"), {
			timezone: "Europe/London",
		}),
	);

	// ── Dispatch at session boundaries ──────────────────────────────────
	tasks.push(cron.schedule("5 8 * * 1-5", () => runJob("dispatch"), { timezone: "Europe/London" }));
	tasks.push(
		cron.schedule("35 14 * * 1-5", () => runJob("dispatch"), { timezone: "Europe/London" }),
	);
	tasks.push(
		cron.schedule("35 16 * * 1-5", () => runJob("dispatch"), { timezone: "Europe/London" }),
	);
	tasks.push(
		cron.schedule("0 18 * * 1-5", () => runJob("dispatch"), { timezone: "Europe/London" }),
	);

	// ── Risk & guardian ─────────────────────────────────────────────────
	tasks.push(
		cron.schedule("0 8 * * 1-5", () => runJob("guardian_start"), { timezone: "Europe/London" }),
	);
	tasks.push(
		cron.schedule("15 21 * * 1-5", () => runJob("guardian_stop"), { timezone: "Europe/London" }),
	);
	tasks.push(
		cron.schedule("*/10 8-21 * * 1-5", () => runJob("risk_guardian"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("55 7 * * 1-5", () => runJob("risk_daily_reset"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("50 7 * * 1", () => runJob("risk_weekly_reset"), {
			timezone: "Europe/London",
		}),
	);

	// ── Live evaluation ─────────────────────────────────────────────────
	tasks.push(
		cron.schedule("7,17,27,37,47,57 14-20 * * 1-5", () => runJob("live_evaluation"), {
			timezone: "Europe/London",
		}),
	);

	// ── Post-close analysis (22:00+) ────────────────────────────────────
	tasks.push(
		cron.schedule("0 22 * * 1-5", () => runJob("daily_summary"), { timezone: "Europe/London" }),
	);
	tasks.push(
		cron.schedule("5 22 * * 1-5", () => runJob("promotion_check"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("15 22 * * 1-5", () => runJob("trade_review"), { timezone: "Europe/London" }),
	);
	tasks.push(
		cron.schedule("25 22 * * 1-5", () => runJob("missed_opportunity_daily"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("35 22 * * 1-5", () => runJob("daily_tournament"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("45 22 * * 2,5", () => runJob("pattern_analysis"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("45 22 * * 3", () => runJob("missed_opportunity_weekly"), {
			timezone: "Europe/London",
		}),
	);

	// Proposal #4 — research_outcome backfill (daily, post-close telemetry).
	tasks.push(
		cron.schedule("50 22 * * 1-5", () => runJob("research_calibration_24h"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("55 22 * * 1-5", () => runJob("research_calibration_48h"), {
			timezone: "Europe/London",
		}),
	);

	// ── Universe management ─────────────────────────────────────────────
	tasks.push(
		cron.schedule("0 3 * * 1", () => runJob("universe_refresh_weekly"), {
			timezone: "UTC",
		}),
	);
	tasks.push(
		cron.schedule("30 22 * * 1-5", () => runJob("universe_delta_daily"), {
			timezone: "Europe/London",
		}),
	);

	// ── Pre-market & maintenance ────────────────────────────────────────
	tasks.push(
		cron.schedule("0 6 * * 1-5", () => runJob("earnings_calendar_sync"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("0 7 * * 1-5", () => runJob("heartbeat"), { timezone: "Europe/London" }),
	);

	// ── Weekend ─────────────────────────────────────────────────────────
	tasks.push(
		cron.schedule("30 17 * * 0", () => runJob("weekly_digest"), { timezone: "Europe/London" }),
	);
	tasks.push(
		cron.schedule("0 18 * * 0", () => runJob("strategy_evolution"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("0 19 * * 0", () => runJob("self_improvement"), {
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
