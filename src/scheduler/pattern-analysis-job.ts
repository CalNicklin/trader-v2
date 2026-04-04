import { runMetaEvolutionUpdate } from "../learning/meta-evolution.ts";
import { runPatternAnalysis } from "../learning/pattern-analysis.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "pattern-analysis-job" });

export async function runPatternAnalysisJob(): Promise<void> {
	const result = await runPatternAnalysis();
	log.info(
		{ observations: result.observations, skippedBudget: result.skippedBudget },
		"Pattern analysis complete",
	);

	// Run meta-evolution update alongside pattern analysis
	await runMetaEvolutionUpdate();
	log.info("Meta-evolution hit rates updated");
}
