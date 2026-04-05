import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "guardian-job" });

export async function startGuardianJob(): Promise<void> {
	const config = getConfig();
	if (!config.LIVE_TRADING_ENABLED) {
		log.info("Live trading disabled — guardian not started");
		return;
	}

	const { isConnected } = await import("../broker/connection.ts");
	if (!isConnected()) {
		log.warn("IBKR not connected — guardian not started");
		return;
	}

	const { startGuardian } = await import("../broker/guardian.ts");
	startGuardian();
}

export async function stopGuardianJob(): Promise<void> {
	const { stopGuardian } = await import("../broker/guardian.ts");
	stopGuardian();
}
