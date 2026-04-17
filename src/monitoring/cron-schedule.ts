import { CronExpressionParser } from "cron-parser";

export interface CronEntry {
	cron: string;
}

export interface CronOccurrence {
	name: string;
	nextRun: string; // ISO string
	nextRunIn: string; // human-readable "2h 15m"
}

/**
 * Static map of all cron jobs — mirrors src/scheduler/cron.ts.
 * Maintained manually; if a job is added/removed in cron.ts, update here.
 */
export const CRON_SCHEDULE: Record<string, CronEntry> = {
	// Per-market quote refresh
	quote_refresh_uk: { cron: "*/10 8-16 * * 1-5" },
	quote_refresh_us: { cron: "5,15,25,35,45,55 14-20 * * 1-5" },
	quote_refresh_us_close: { cron: "*/5 21 * * 1-5" },

	// Per-market strategy evaluation
	strategy_eval_uk: { cron: "3,13,23,33,43,53 8-16 * * 1-5" },
	strategy_eval_us: { cron: "8,18,28,38,48,58 14-20 * * 1-5" },

	// News polling (pre-market through US session)
	news_poll: { cron: "*/10 6-20 * * 1-5" },

	// Dispatch at session boundaries
	dispatch_uk_open: { cron: "5 8 * * 1-5" },
	dispatch_us_open: { cron: "35 14 * * 1-5" },
	dispatch_uk_close: { cron: "35 16 * * 1-5" },
	dispatch_us_afternoon: { cron: "0 18 * * 1-5" },

	// Risk & guardian
	guardian_start: { cron: "0 8 * * 1-5" },
	guardian_stop: { cron: "15 21 * * 1-5" },
	risk_guardian: { cron: "*/10 8-21 * * 1-5" },
	risk_daily_reset: { cron: "55 7 * * 1-5" },
	risk_weekly_reset: { cron: "50 7 * * 1" },

	// Live evaluation
	live_evaluation: { cron: "7,17,27,37,47,57 14-20 * * 1-5" },

	// Post-close analysis (22:00+)
	daily_summary: { cron: "0 22 * * 1-5" },
	promotion_check: { cron: "5 22 * * 1-5" },
	trade_review: { cron: "15 22 * * 1-5" },
	missed_opportunity_daily: { cron: "25 22 * * 1-5" },
	daily_tournament: { cron: "35 22 * * 1-5" },
	pattern_analysis: { cron: "45 22 * * 2,5" },
	missed_opportunity_weekly: { cron: "45 22 * * 3" },
	research_calibration_24h: { cron: "50 22 * * 1-5" },
	research_calibration_48h: { cron: "55 22 * * 1-5" },

	// Pre-market & maintenance
	earnings_calendar_sync: { cron: "0 6 * * 1-5" },
	heartbeat: { cron: "0 7 * * 1-5" },

	// Weekend
	weekly_digest: { cron: "30 17 * * 0" },
	strategy_evolution: { cron: "0 18 * * 0" },
	self_improvement: { cron: "0 19 * * 0" },
};

function formatDuration(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

export function getNextCronOccurrences(): CronOccurrence[] {
	const now = new Date();
	const results: CronOccurrence[] = [];

	for (const [name, entry] of Object.entries(CRON_SCHEDULE)) {
		const interval = CronExpressionParser.parse(entry.cron, {
			currentDate: now,
			tz: "Europe/London",
		});
		const next = interval.next().toDate();
		const diffMs = next.getTime() - now.getTime();

		results.push({
			name,
			nextRun: next.toISOString(),
			nextRunIn: formatDuration(diffMs),
		});
	}

	results.sort((a, b) => new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime());
	return results;
}
