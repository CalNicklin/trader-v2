import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { getDb } from "../db/client";
import { improvementProposals } from "../db/schema";
import { getPerformanceLandscape } from "../evolution/analyzer";
import type { PerformanceLandscape } from "../evolution/types";
import { canAffordCall } from "../utils/budget";
import { createChildLogger } from "../utils/logger";
import { recordUsage } from "../utils/token-tracker";
import { generateCodeChange } from "./code-generator";
import { createPR } from "./github";
import type { ImprovementIdea, ProposalResult } from "./types";

const log = createChildLogger({ module: "self-improve-proposer" });

const PROPOSER_ESTIMATED_COST_USD = 0.08;

export function generateBranchName(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	const date = new Date().toISOString().split("T")[0]!.replace(/-/g, "");
	return `self-improve/${slug}-${date}`;
}

function buildProposerPrompt(landscapeJson: string, landscape: PerformanceLandscape): string {
	const actionLines: string[] = [];
	for (const strategy of landscape.strategies) {
		if (strategy.suggestedActions.length > 0) {
			actionLines.push(`\n${strategy.name} (id=${strategy.id}):`);
			for (const action of strategy.suggestedActions.slice(0, 3)) {
				actionLines.push(`  → ${action.direction} ${action.parameter}: ${action.reasoning}`);
			}
		}
	}

	const actionsSection =
		actionLines.length > 0
			? `\n## Learning Loop Suggested Actions\nThese are parameter change suggestions from the learning loop. Consider whether code changes could address the underlying issues:\n${actionLines.join("\n")}\n`
			: "";

	return `You are analysing a trading agent system to identify code improvements.

## Current System State
${landscapeJson}
${actionsSection}
## Scope
You may propose changes to any file in the codebase. All proposals will be submitted as PRs.

## Instructions
Review the system state and propose 1-3 specific, actionable code improvements. Focus on:
- Strategy evaluation logic that could be more accurate
- Signal computation that could capture more alpha
- News classification prompts that could be more precise
- Reporting templates that could be more informative

For each proposal, return a JSON array:
\`\`\`json
[
  {
    "title": "Short descriptive title",
    "description": "Detailed description of what to change and why",
    "targetFile": "src/path/to/file.ts",
    "changeDescription": "Specific instructions for the code change",
    "reasoning": "Why this improvement matters based on the data",
    "priority": "high" | "medium" | "low"
  }
]
\`\`\`

Rules:
- Only propose changes you are confident will improve the system
- Base proposals on actual performance data, not speculation
- Each proposal must target a specific file
- If the system is performing well, return an empty array []
- Return ONLY the JSON array, no other text`;
}

export function parseProposerResponse(text: string): ImprovementIdea[] {
	const jsonMatch = text.match(/```(?:json)?\n?([\s\S]*?)```/);
	const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : text.trim();

	try {
		const parsed = JSON.parse(jsonStr);
		if (!Array.isArray(parsed)) return [];

		return parsed.filter(
			(item: unknown): item is ImprovementIdea =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as ImprovementIdea).title === "string" &&
				typeof (item as ImprovementIdea).targetFile === "string" &&
				typeof (item as ImprovementIdea).changeDescription === "string",
		);
	} catch {
		log.warn("Failed to parse proposer response as JSON");
		return [];
	}
}

export async function runSelfImprovementCycle(): Promise<ProposalResult> {
	const result: ProposalResult = { prsCreated: 0, errors: [] };
	const config = getConfig();

	if (!(await canAffordCall(PROPOSER_ESTIMATED_COST_USD))) {
		log.warn("Budget exceeded, skipping self-improvement cycle");
		result.errors.push("Budget exceeded");
		return result;
	}

	const landscape = await getPerformanceLandscape();
	const landscapeJson = JSON.stringify(landscape, null, 2);

	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
	const response = await client.messages.create({
		model: config.CLAUDE_MODEL_HEAVY,
		max_tokens: 4096,
		messages: [{ role: "user", content: buildProposerPrompt(landscapeJson, landscape) }],
	});

	await recordUsage("self_improvement", response.usage.input_tokens, response.usage.output_tokens);

	const text = response.content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n");

	const ideas = parseProposerResponse(text);
	log.info({ ideaCount: ideas.length }, "Self-improvement ideas generated");

	if (ideas.length === 0) {
		log.info("No improvement ideas proposed — system performing well");
		return result;
	}

	const db = getDb();
	for (const idea of ideas) {
		const newContent = await generateCodeChange(idea.targetFile, idea.changeDescription);
		if (newContent) {
			const branch = generateBranchName(idea.title);
			const prUrl = await createPR({
				title: idea.title,
				description: `${idea.description}\n\n**Reasoning:** ${idea.reasoning}`,
				branch,
				changes: [{ path: idea.targetFile, content: newContent }],
			});
			if (prUrl) {
				db.insert(improvementProposals)
					.values({
						title: idea.title,
						description: idea.description,
						filesChanged: idea.targetFile,
						prUrl,
						status: "PR_CREATED" as const,
					})
					.run();
				result.prsCreated++;
				log.info({ title: idea.title, prUrl }, "Self-improvement PR created");
			} else {
				result.errors.push(`Failed to create PR: ${idea.title}`);
			}
		} else {
			result.errors.push(`Failed to generate code for: ${idea.title}`);
		}
	}

	return result;
}
