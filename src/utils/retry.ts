import { createChildLogger } from "./logger.ts";

const log = createChildLogger({ module: "retry" });

export interface RetryOptions {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	backoffMultiplier: number;
}

const defaultOptions: RetryOptions = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	backoffMultiplier: 2,
};

export async function withRetry<T>(
	fn: () => Promise<T>,
	label: string,
	options: Partial<RetryOptions> = {},
): Promise<T> {
	const opts = { ...defaultOptions, ...options };
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt === opts.maxAttempts) break;

			const delay = Math.min(
				opts.baseDelayMs * opts.backoffMultiplier ** (attempt - 1),
				opts.maxDelayMs,
			);
			log.warn(
				{ attempt, maxAttempts: opts.maxAttempts, delay, error: lastError.message },
				`${label}: retrying after error`,
			);
			await Bun.sleep(delay);
		}
	}

	throw lastError;
}
