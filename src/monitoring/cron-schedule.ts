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
	quote_refresh: { cron: "*/10 8-20 * * 1-5" },
	heartbeat: { cron: "0 7 * * 1-5" },
	strategy_evaluation: { cron: "5,15,25,35,45,55 8-20 * * 1-5" },
	daily_summary: { cron: "5 21 * * 1-5" },
	strategy_evolution: { cron: "0 18 * * 0" },
	trade_review: { cron: "15 21 * * 1-5" },
	pattern_analysis: { cron: "30 21 * * 2,5" },
	weekly_digest: { cron: "30 17 * * 0" },
	news_poll: { cron: "2,12,22,32,42,52 8-20 * * 1-5" },
	earnings_calendar_sync: { cron: "0 6 * * 1-5" },
	self_improvement: { cron: "0 19 * * 0" },
	guardian_start: { cron: "0 8 * * 1-5" },
	guardian_stop: { cron: "0 21 * * 1-5" },
	live_evaluation: { cron: "7,17,27,37,47,57 8-20 * * 1-5" },
	risk_guardian: { cron: "4,14,24,34,44,54 8-20 * * 1-5" },
	risk_daily_reset: { cron: "55 7 * * 1-5" },
	risk_weekly_reset: { cron: "50 7 * * 1" },
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
