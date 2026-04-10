// scripts/seed-ftse100.ts
//
// Adds FTSE-100 symbols to all paper strategies whose universe currently
// contains any LSE symbol. Dry-run by default. Pass --commit to apply.
//
// Usage:
//   bun scripts/seed-ftse100.ts            # dry run
//   bun scripts/seed-ftse100.ts --commit   # apply

import { eq } from "drizzle-orm";
import { getFtse100Universe } from "../src/data/ftse100.ts";
import { getDb } from "../src/db/client.ts";
import { strategies } from "../src/db/schema.ts";
import { createChildLogger } from "../src/utils/logger.ts";

const log = createChildLogger({ module: "seed-ftse100" });

async function main() {
	const commit = process.argv.includes("--commit");
	const ftse100 = await getFtse100Universe();
	log.info({ count: ftse100.length }, "FTSE-100 constituents loaded");

	const db = getDb();
	const paperStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	const ftse100Specs = ftse100.map((c) => `${c.symbol}:LSE`);
	let touched = 0;

	for (const s of paperStrategies) {
		const existing: string[] = JSON.parse(s.universe ?? "[]");
		const hasLse = existing.some((spec) => spec.endsWith(":LSE"));
		if (!hasLse) continue;

		const merged = Array.from(new Set([...existing, ...ftse100Specs]));
		if (merged.length === existing.length) continue;

		log.info(
			{
				strategyId: s.id,
				name: s.name,
				before: existing.length,
				after: merged.length,
				added: merged.length - existing.length,
			},
			commit ? "APPLYING" : "DRY RUN",
		);

		if (commit) {
			await db
				.update(strategies)
				.set({ universe: JSON.stringify(merged) })
				.where(eq(strategies.id, s.id));
		}
		touched++;
	}

	log.info({ touched, commit }, commit ? "Seed complete" : "Dry run complete");
}

main().catch((err) => {
	log.error({ err }, "Seeder failed");
	process.exit(1);
});
