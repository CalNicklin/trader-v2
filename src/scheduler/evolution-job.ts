import { runEvolutionCycle } from "../evolution/index";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "scheduler:evolution" });

// Note: Drawdown checks, tournaments, and population culling are now handled
// by the daily_tournament job (weekdays at 21:45). This weekly job only handles
// AI-driven mutation proposals and spawning.
export async function runEvolutionJob(): Promise<void> {
	log.info("Starting weekly evolution cycle");
	const result = await runEvolutionCycle();
	const summary = [
		`drawdownKills=${result.drawdownKills.length}`,
		`tournaments=${result.tournaments}`,
		`populationCulls=${result.populationCulls.length}`,
		`spawned=${result.spawned.length}`,
		result.skippedReason ? `skippedReason=${result.skippedReason}` : null,
	]
		.filter(Boolean)
		.join(", ");
	log.info({ ...result, summary }, "Evolution cycle complete");
}
