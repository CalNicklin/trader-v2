import { sql } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { earningsCalendar } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";

const log = createChildLogger({ module: "earnings-sync" });

interface FinnhubEarning {
	date: string;
	epsActual: number | null;
	epsEstimate: number | null;
	hour: string;
	quarter: number;
	revenueActual: number | null;
	revenueEstimate: number | null;
	symbol: string;
	year: number;
}

export async function runEarningsSync(): Promise<void> {
	const config = getConfig();
	if (!config.FINNHUB_API_KEY) {
		log.warn("FINNHUB_API_KEY not set — skipping earnings sync");
		return;
	}

	const from = new Date();
	const to = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000); // next 2 weeks
	const fromStr = from.toISOString().split("T")[0];
	const toStr = to.toISOString().split("T")[0];

	const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromStr}&to=${toStr}&token=${config.FINNHUB_API_KEY}`;

	try {
		const response = await withRetry(
			async () => {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
				return res;
			},
			"earnings-sync",
			{ maxAttempts: 2 },
		);

		const data = (await response.json()) as { earningsCalendar?: FinnhubEarning[] };
		const earnings: FinnhubEarning[] = data?.earningsCalendar ?? [];

		const db = getDb();
		let inserted = 0;

		// N+1 insert loop is acceptable here: dataset is typically <100 entries for 2 weeks.
		// earningsCalendar has no unique constraint, so we use select-then-insert to avoid dups.
		for (const earning of earnings) {
			if (!earning.symbol || !earning.date) continue;

			try {
				const existing = await db
					.select({ id: earningsCalendar.id })
					.from(earningsCalendar)
					.where(
						sql`${earningsCalendar.symbol} = ${earning.symbol} AND ${earningsCalendar.date} = ${earning.date}`,
					)
					.limit(1);

				if (existing.length === 0) {
					await db.insert(earningsCalendar).values({
						symbol: earning.symbol,
						exchange: "NASDAQ", // Finnhub calendar is primarily US
						date: earning.date,
						estimatedEps: earning.epsEstimate,
						source: "finnhub",
					});
					inserted++;
				}
			} catch (rowError) {
				log.warn(
					{ symbol: earning.symbol, date: earning.date, error: rowError },
					"Failed to upsert earnings row — skipping",
				);
			}
		}

		log.info({ total: earnings.length, inserted }, "Earnings calendar synced");
	} catch (error) {
		log.error({ error }, "Earnings sync failed");
	}
}
