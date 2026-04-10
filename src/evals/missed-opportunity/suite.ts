// src/evals/missed-opportunity/suite.ts
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { allTrackerGraders } from "./graders.ts";
import { type TrackerInput, trackerTasks } from "./tasks.ts";

function simulateTracker(input: TrackerInput): { missedSymbols: string[]; reviewedCount: number } {
	const missedSymbols: string[] = [];
	let reviewed = 0;

	for (const analysis of input.analyses) {
		if (analysis.priceAtAnalysis == null) continue;
		if (analysis.inUniverse) {
			reviewed++;
			continue;
		}
		if (analysis.direction === "avoid") {
			reviewed++;
			continue;
		}

		const currentPrice = input.currentPrices[analysis.symbol];
		if (currentPrice == null) continue;

		reviewed++;
		const changePct = ((currentPrice - analysis.priceAtAnalysis) / analysis.priceAtAnalysis) * 100;
		const correctDirection =
			(analysis.direction === "long" && changePct > 0) ||
			(analysis.direction === "short" && changePct < 0);

		if (Math.abs(changePct) > 2 && correctDirection) {
			missedSymbols.push(analysis.symbol);
		}
	}

	return { missedSymbols, reviewedCount: reviewed };
}

export async function runMissedOpportunityEvals(options: { saveDir?: string } = {}): Promise<void> {
	const saveDir = options.saveDir ?? "src/evals/missed-opportunity/results";

	const results = await runSuite(
		trackerTasks,
		async (input, _reference) => simulateTracker(input),
		allTrackerGraders,
		{ trials: 1, suiteName: "missed-opportunity" },
	);

	console.log(formatSuiteReport(results));
	await Bun.write(`${saveDir}/missed-opportunity-latest.json`, JSON.stringify(results, null, 2));
}
