import { z } from "zod";

const envSchema = z.object({
	// Claude
	ANTHROPIC_API_KEY: z.string(),
	CLAUDE_MODEL: z.string().default("claude-sonnet-4-5-20250929"),
	CLAUDE_MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),

	// Resend
	RESEND_API_KEY: z.string(),
	ALERT_EMAIL_FROM: z.string().default("trader@updates.example.com"),
	ALERT_EMAIL_TO: z.string(),

	// GitHub (for self-improvement PRs)
	GITHUB_TOKEN: z.string().optional(),
	GITHUB_REPO_OWNER: z.string().optional(),
	GITHUB_REPO_NAME: z.string().default("trader-v2"),

	// Database
	DB_PATH: z.string().default("./data/trader.db"),

	// Logging
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

	// Environment
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

	// Cost control
	DAILY_API_BUDGET_USD: z.coerce.number().default(0),

	// Finnhub
	FINNHUB_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function resetConfigForTesting(): void {
	_config = null;
}

export function getConfig(): Config {
	if (!_config) {
		const result = envSchema.safeParse(process.env);
		if (!result.success) {
			console.error("Invalid environment variables:");
			for (const issue of result.error.issues) {
				console.error(`  ${issue.path.join(".")}: ${issue.message}`);
			}
			process.exit(1);
		}
		_config = result.data;
	}
	return _config;
}
