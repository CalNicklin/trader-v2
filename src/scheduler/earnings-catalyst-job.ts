import { createChildLogger } from "../utils/logger.ts";
import { markLedToPromotion, writeCatalystEvent } from "../watchlist/catalyst-events.ts";
import { EARNINGS_LOOKAHEAD_DAYS } from "../watchlist/constants.ts";
import { promoteToWatchlist } from "../watchlist/promote.ts";

const log = createChildLogger({ module: "earnings-catalyst-job" });

type FetchLike = (url: string) => Promise<Pick<Response, "ok" | "status" | "json">>;

export interface EarningsCatalystJobInput {
	fetchImpl?: FetchLike;
	finnhubApiKey: string;
	now: Date;
}

export interface EarningsCatalystJobResult {
	promoted: number;
	skipped: number;
	error?: string;
}

interface FinnhubEarningRow {
	symbol: string;
	date: string; // YYYY-MM-DD
	epsEstimate: number | null;
}

export async function runEarningsCatalystJob(
	input: EarningsCatalystJobInput,
): Promise<EarningsCatalystJobResult> {
	const f = input.fetchImpl ?? fetch;
	const now = input.now;
	const from = now.toISOString().slice(0, 10);
	// Approximate trading-day lookahead with calendar days × 1.5 for weekend padding
	const toMs = now.getTime() + EARNINGS_LOOKAHEAD_DAYS * 1.5 * 86400_000;
	const to = new Date(toMs).toISOString().slice(0, 10);

	let rows: FinnhubEarningRow[];
	try {
		const res = await f(
			`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${input.finnhubApiKey}`,
		);
		if (!res.ok) throw new Error(`Finnhub ${res.status}`);
		const body = (await res.json()) as { earningsCalendar?: FinnhubEarningRow[] };
		rows = body.earningsCalendar ?? [];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.warn({ err: msg }, "Earnings calendar fetch failed");
		return { promoted: 0, skipped: 0, error: msg };
	}

	let promoted = 0;
	let skipped = 0;
	const cutoffMs = now.getTime() + EARNINGS_LOOKAHEAD_DAYS * 86400_000;

	for (const row of rows) {
		const reportMs = Date.parse(row.date);
		if (Number.isNaN(reportMs) || reportMs > cutoffMs) {
			skipped++;
			continue;
		}

		// Finnhub doesn't always return exchange. For v1 we attempt NASDAQ then NYSE.
		// promoteToWatchlist rejects if not in investable_universe on a given exchange.
		for (const exchange of ["NASDAQ", "NYSE"]) {
			const eventId = writeCatalystEvent({
				symbol: row.symbol,
				exchange,
				eventType: "earnings",
				source: "finnhub_earning_calendar",
				payload: { date: row.date, epsEstimate: row.epsEstimate ?? null },
			});

			const result = await promoteToWatchlist({
				symbol: row.symbol,
				exchange,
				reason: "earnings",
				payload: { date: row.date },
			});

			if (result.status === "inserted" || result.status === "updated") {
				markLedToPromotion(eventId);
				promoted++;
				break; // Accept the first exchange that succeeds
			}
		}
	}

	log.info({ promoted, skipped, from, to }, "Earnings catalyst job complete");
	return { promoted, skipped };
}
