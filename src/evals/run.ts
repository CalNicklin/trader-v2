import { mkdir } from "node:fs/promises";

// Ensure optional env vars exist so config validation passes in eval context
if (!process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = "eval-placeholder";
if (!process.env.ALERT_EMAIL_TO) process.env.ALERT_EMAIL_TO = "eval@placeholder.local";

const args = process.argv.slice(2);
const suite = args[0] || "all";
const trials = Number.parseInt(
	args.find((a) => a.startsWith("--trials="))?.split("=")[1] ?? "3",
	10,
);
const tags = args
	.find((a) => a.startsWith("--tags="))
	?.split("=")[1]
	?.split(",");

const saveDir = "src/evals/results";
await mkdir(saveDir, { recursive: true });

console.log(`\nTrader v2 — AI Evaluations`);
console.log(`Suite: ${suite} | Trials: ${trials}${tags ? ` | Tags: ${tags.join(",")}` : ""}\n`);

const start = Date.now();

if (suite === "all" || suite === "pre-filter") {
	const { runPreFilterEvals } = await import("./pre-filter/suite.ts");
	await runPreFilterEvals({ tags, saveDir });
}

if (suite === "all" || suite === "classifier") {
	const { runClassifierEvals } = await import("./classifier/suite.ts");
	await runClassifierEvals({ trials, tags, saveDir });
}

if (suite === "all" || suite === "pipeline") {
	const { runPipelineEvals } = await import("./pipeline/suite.ts");
	await runPipelineEvals({ trials, tags, saveDir });
}

if (suite === "all" || suite === "evolution") {
	const { runEvolutionEvalSuite } = await import("./evolution/suite.ts");
	await runEvolutionEvalSuite({ trials, suiteName: "evolution" });
}

if (suite === "all" || suite === "learning") {
	const { runLearningEvalSuite } = await import("./learning/suite.ts");
	await runLearningEvalSuite({ trials, suiteName: "learning" });
}

if (suite === "all" || suite === "sentiment") {
	const { runSentimentEvalSuite } = await import("./sentiment/suite.ts");
	await runSentimentEvalSuite({ trials, suiteName: "sentiment" });
}

if (suite === "all" || suite === "research-agent") {
	const { runResearchAgentEvals } = await import("./research-agent/suite.ts");
	await runResearchAgentEvals({ trials, saveDir: "src/evals/research-agent/results" });
}

if (suite === "all" || suite === "catalyst-dispatch") {
	const { runCatalystDispatchEvals } = await import("./catalyst-dispatch/suite.ts");
	await runCatalystDispatchEvals({ trials, saveDir: "src/evals/catalyst-dispatch/results" });
}

console.log(`\nTotal duration: ${Date.now() - start}ms`);
