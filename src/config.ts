import { z } from "zod";

const envSchema = z.object({
	// Claude
	ANTHROPIC_API_KEY: z.string(),
	CLAUDE_MODEL: z.string().default("claude-sonnet-4-6"),
	CLAUDE_MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),
	CLAUDE_MODEL_HEAVY: z.string().default("claude-opus-4-6"),

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

	// IBKR
	IBKR_HOST: z.string().default("127.0.0.1"),
	IBKR_PORT: z.coerce.number().default(4002), // 4001=live TWS, 4002=paper TWS, 7497=live gateway
	IBKR_CLIENT_ID: z.coerce.number().default(1),

	// Live trading kill switch (default OFF)
	LIVE_TRADING_ENABLED: z
		.enum(["true", "false"])
		.default("false")
		.transform((v) => v === "true"),

	// Catalyst-triggered dispatch kill switch (default OFF)
	CATALYST_DISPATCH_ENABLED: z
		.enum(["true", "false"])
		.default("false")
		.transform((v) => v === "true"),

	// Paper-engine slippage haircut in basis points (one-way, applied per fill).
	// BUY entries fill at price * (1 + bps/10000); SELL entries at (1 - bps/10000).
	// Exits mirror per side: closing a long (SELL) fills at (1 - bps/10000),
	// closing a short (BUY) at (1 + bps/10000). Flat until recalibrated from
	// real IBKR fills (TRA-6).
	PAPER_SLIPPAGE_BPS: z.coerce.number().nonnegative().default(5),

	// HTTP server
	HTTP_PORT: z.coerce.number().default(3847),

	// Uptime Kuma
	UPTIME_KUMA_PUSH_URL: z.string().url().optional(),

	// Admin auth
	ADMIN_PASSWORD: z.string().optional(),
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
