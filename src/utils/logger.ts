import pino from "pino";
import { getConfig } from "../config.ts";

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
	if (!_logger) {
		const config = getConfig();
		_logger = pino({
			level: config.LOG_LEVEL,
			base: { service: "trader-v2" },
			timestamp: pino.stdTimeFunctions.isoTime,
		});
	}
	return _logger;
}

export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
	return getLogger().child(bindings);
}
