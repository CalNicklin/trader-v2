import { getDb } from "../db/client.ts";
import { universeSnapshots } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "universe-snapshots" });

export interface SymbolRef {
	symbol: string;
	exchange: string;
}

export interface SnapshotInput {
	current: SymbolRef[];
	previous: SymbolRef[];
	// Keyed by `${symbol}:${exchange}` — optional, only for removed rows.
	removalReasons?: Record<string, string>;
}

const key = (r: SymbolRef) => `${r.symbol}:${r.exchange}`;

export async function writeDailySnapshot(
	snapshotDate: string,
	input: SnapshotInput,
): Promise<{ added: number; removed: number }> {
	const db = getDb();
	const currentSet = new Set(input.current.map(key));
	const previousSet = new Set(input.previous.map(key));

	const added = input.current.filter((r) => !previousSet.has(key(r)));
	const removed = input.previous.filter((r) => !currentSet.has(key(r)));

	if (added.length === 0 && removed.length === 0) {
		log.info({ snapshotDate }, "No universe changes to snapshot");
		return { added: 0, removed: 0 };
	}

	const rows = [
		...added.map((r) => ({
			snapshotDate,
			symbol: r.symbol,
			exchange: r.exchange,
			action: "added" as const,
			reason: null,
		})),
		...removed.map((r) => ({
			snapshotDate,
			symbol: r.symbol,
			exchange: r.exchange,
			action: "removed" as const,
			reason: input.removalReasons?.[key(r)] ?? null,
		})),
	];

	await db.insert(universeSnapshots).values(rows);
	log.info(
		{ snapshotDate, added: added.length, removed: removed.length },
		"Universe snapshot written",
	);
	return { added: added.length, removed: removed.length };
}
