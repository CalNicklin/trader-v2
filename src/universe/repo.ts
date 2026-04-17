import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse } from "../db/schema.ts";
import type { SymbolRef } from "./snapshots.ts";

export async function getActiveUniverseMembership(): Promise<SymbolRef[]> {
	const db = getDb();
	const rows = await db
		.select({ symbol: investableUniverse.symbol, exchange: investableUniverse.exchange })
		.from(investableUniverse)
		.where(eq(investableUniverse.active, true))
		.all();
	return rows;
}
