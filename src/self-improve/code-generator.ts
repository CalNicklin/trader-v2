import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { canAffordCall } from "../utils/budget";
import { createChildLogger } from "../utils/logger";
import { recordUsage } from "../utils/token-tracker";

const log = createChildLogger({ module: "self-improve-codegen" });

const CODE_GEN_ESTIMATED_COST_USD = 0.05;

export function extractCodeFromResponse(text: string): string | null {
	const codeMatch = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
	const content = codeMatch ? codeMatch[1]!.trim() : text.trim();

	if (content.length < 10) {
		return null;
	}

	return content;
}

export async function generateCodeChange(
	filePath: string,
	changeDescription: string,
): Promise<string | null> {
	const config = getConfig();

	if (!(await canAffordCall(CODE_GEN_ESTIMATED_COST_USD))) {
		log.warn("Budget exceeded, skipping code generation");
		return null;
	}

	let currentContent: string;
	try {
		const file = Bun.file(filePath);
		currentContent = await file.text();
	} catch (error) {
		log.error({ filePath, error }, "Failed to read file for code generation");
		return null;
	}

	const prompt = `You are modifying a TypeScript file for a trading agent. Apply the following change:

## Change Description
${changeDescription}

## Current File Content (${filePath})
\`\`\`typescript
${currentContent}
\`\`\`

## Rules
- Only modify what's necessary for the described change
- Maintain the existing code style (tabs for indentation)
- Do not add comments explaining the change
- Return ONLY the complete modified file content, no explanation
- Keep all existing imports and exports
- The output must be valid TypeScript

Return the complete modified file content:`;

	try {
		const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
		const response = await client.messages.create({
			model: config.CLAUDE_MODEL,
			max_tokens: 8192,
			messages: [{ role: "user", content: prompt }],
		});

		await recordUsage(
			"code_generation",
			response.usage.input_tokens,
			response.usage.output_tokens,
		);

		const text = response.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n");

		const content = extractCodeFromResponse(text);
		if (!content) {
			log.warn({ filePath }, "Generated code change is suspiciously short");
			return null;
		}

		log.info(
			{
				filePath,
				originalLength: currentContent.length,
				newLength: content.length,
			},
			"Code change generated",
		);
		return content;
	} catch (error) {
		log.error({ filePath, error }, "Code generation failed");
		return null;
	}
}
