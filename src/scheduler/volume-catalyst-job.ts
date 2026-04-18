import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { markLedToPromotion, writeCatalystEvent } from "../watchlist/catalyst-events.ts";
import { VOLUME_TRIGGER_RATIO } from "../watchlist/constants.ts";
import { promoteToWatchlist } from "../watchlist/promote.ts";

const log = createChildLogger({ module: "volume-catalyst-job" });

export interface VolumeCatalystJobInput {
	scope: "us" | "uk";
	now: Date;
}

export interface VolumeCatalystJobResult {
	scanned: number;
	promoted: number;
}

const SCOPE_EXCHANGES: Record<VolumeCatalystJobInput["scope"], string[]> = {
	us: ["NASDAQ", "NYSE"],
	uk: ["LSE", "AIM"],
};

export async function runVolumeCatalystJob(
	input: VolumeCatalystJobInput,
): Promise<VolumeCatalystJobResult> {
	const db = getDb();
	const exchanges = SCOPE_EXCHANGES[input.scope];

	const rows = db.select().from(quotesCache).where(inArray(quotesCache.exchange, exchanges)).all();

	let promoted = 0;
	for (const q of rows) {
		if (q.volume == null || q.avgVolume == null || q.avgVolume <= 0) continue;
		const ratio = q.volume / q.avgVolume;
		if (ratio < VOLUME_TRIGGER_RATIO) continue;

		const eventId = writeCatalystEvent({
			symbol: q.symbol,
			exchange: q.exchange,
			eventType: "volume",
			source: "volume_catalyst_job",
			payload: { volume: q.volume, avgVolume: q.avgVolume, ratio },
		});

		const result = await promoteToWatchlist({
			symbol: q.symbol,
			exchange: q.exchange,
			reason: "volume",
			payload: { ratio },
		});

		if (result.status === "inserted" || result.status === "updated") {
			markLedToPromotion(eventId);
			promoted++;
		}
	}

	log.info({ scope: input.scope, scanned: rows.length, promoted }, "Volume catalyst job complete");
	return { scanned: rows.length, promoted };
}
