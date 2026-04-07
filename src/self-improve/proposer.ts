import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { getDb } from "../db/client";
import { improvementProposals } from "../db/schema";
import { getPerformanceLandscape } from "../evolution/analyzer";
import { canAffordCall } from "../utils/budget";
import { createChildLogger } from "../utils/logger";
import { recordUsage } from "../utils/token-tracker";
import { generateCodeChange } from "./code-generator";
import { createIssue, createPR } from "./github";
import {
	HUMAN_ONLY_PATHS,
	type ImprovementIdea,
	type ProposalResult,
	WHITELISTED_PATHS,
} from "./types";

const log = createChildLogger({ module: "self-improve-proposer" });

const PROPOSER_ESTIMATED_COST_USD = 0.08;

export function isWhitelistedPath(filePath: string): boolean {
	return WHITELISTED_PATHS.some((prefix) => filePath.startsWith(prefix));
}

export function isHumanOnlyPath(filePath: string): boolean {
	return HUMAN_ONLY_PATHS.some((prefix) => filePath.startsWith(prefix));
}

export function classifyProposal(targetFile: string): "pr" | "issue" | "skip" {
	if (isWhitelistedPath(targetFile)) return "pr";
	if (isHumanOnlyPath(targetFile)) return "issue";
	return "skip";
}

export function generateBranchName(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	const date = new Date().toISOString().split("T")[0]!.replace(/-/g, "");
	return `self-improve/${slug}-${date}`;
}

function buildProposerPrompt(landscapeJson: string): string {
	return `You are analysing a trading agent system to identify code improvements.

## Current System State
${landscapeJson}

## Whitelisted Files (you can propose direct code changes)
${WHITELISTED_PATHS.join("\n")}

## Human-Only Files (propose as issues for human review)
${HUMAN_ONLY_PATHS.join("\n")}

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
	const result: ProposalResult = { prsCreated: 0, issuesCreated: 0, skipped: 0, errors: [] };
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
		messages: [{ role: "user", content: buildProposerPrompt(landscapeJson) }],
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
		const classification = classifyProposal(idea.targetFile);

		if (classification === "pr") {
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
		} else if (classification === "issue") {
			const issueUrl = await createIssue({
				title: idea.title,
				body: `${idea.description}\n\n**Target file:** \`${idea.targetFile}\`\n**Change:** ${idea.changeDescription}\n**Reasoning:** ${idea.reasoning}\n**Priority:** ${idea.priority}`,
				labels: ["agent-suggestion", idea.priority],
			});
			if (issueUrl) {
				db.insert(improvementProposals)
					.values({
						title: idea.title,
						description: idea.description,
						filesChanged: idea.targetFile,
						status: "ISSUE_CREATED" as const,
					})
					.run();
				result.issuesCreated++;
				log.info({ title: idea.title, issueUrl }, "Self-improvement issue created");
			} else {
				result.errors.push(`Failed to create issue: ${idea.title}`);
			}
		} else {
			result.skipped++;
			log.debug(
				{ title: idea.title, classification },
				"Proposal skipped (unclassified path)",
			);
		}
	}

	return result;
}
