import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { catalystEvents } from "../db/schema.ts";

export interface CatalystEventInput {
	symbol: string;
	exchange: string;
	eventType:
		| "news"
		| "research"
		| "earnings"
		| "volume"
		| "feedback"
		| "insider_buy"
		| "filing_8k"
		| "rotation";
	source: string;
	payload: unknown | null;
}

export function writeCatalystEvent(input: CatalystEventInput): number {
	const result = getDb()
		.insert(catalystEvents)
		.values({
			symbol: input.symbol,
			exchange: input.exchange,
			eventType: input.eventType,
			source: input.source,
			payload: input.payload == null ? null : JSON.stringify(input.payload),
		})
		.returning({ id: catalystEvents.id })
		.get();
	if (!result) throw new Error("catalyst event insert returned nothing");
	return result.id;
}

export function markLedToPromotion(id: number): void {
	getDb()
		.update(catalystEvents)
		.set({ ledToPromotion: true })
		.where(eq(catalystEvents.id, id))
		.run();
}
