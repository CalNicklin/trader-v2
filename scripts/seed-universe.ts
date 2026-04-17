#!/usr/bin/env bun
// Manual one-off script to trigger the first universe refresh. Run locally
// against dev DB first, then against VPS production DB via vps-ssh.sh.
import { runWeeklyUniverseRefresh } from "../src/scheduler/universe-jobs.ts";

async function main() {
	console.log("Running initial universe seed...");
	await runWeeklyUniverseRefresh();
	console.log("Done. Check /health for universe stats.");
	process.exit(0);
}

main().catch((err) => {
	console.error("Seed failed:", err);
	process.exit(1);
});
