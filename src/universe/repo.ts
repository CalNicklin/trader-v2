import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse } from "../db/schema.ts";

export interface ActiveMembershipRow {
	symbol: string;
	exchange: string;
	indexSource: string;
}

export async function getActiveUniverseMembership(): Promise<ActiveMembershipRow[]> {
	const db = getDb();
	const rows = await db
		.select({
			symbol: investableUniverse.symbol,
			exchange: investableUniverse.exchange,
			indexSource: investableUniverse.indexSource,
		})
		.from(investableUniverse)
		.where(eq(investableUniverse.active, true))
		.all();
	return rows;
}
