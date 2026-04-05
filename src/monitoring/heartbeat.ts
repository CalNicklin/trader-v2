import { getConfig } from "../config";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "heartbeat" });

export function buildHeartbeatUrl(
	baseUrl: string,
	status: "up" | "down",
	msg: string,
): string {
	const url = new URL(baseUrl);
	url.searchParams.set("status", status);
	url.searchParams.set("msg", msg);
	return url.toString();
}

export async function sendHeartbeat(jobName: string): Promise<boolean> {
	const config = getConfig();
	const pushUrl = config.UPTIME_KUMA_PUSH_URL;

	if (!pushUrl) {
		log.debug("Uptime Kuma push URL not configured, skipping heartbeat");
		return false;
	}

	try {
		const url = buildHeartbeatUrl(pushUrl, "up", `${jobName} OK`);
		const res = await fetch(url, { method: "GET" });

		if (!res.ok) {
			log.warn(
				{ status: res.status, jobName },
				"Heartbeat push returned non-OK status",
			);
			return false;
		}

		log.debug({ jobName }, "Heartbeat sent");
		return true;
	} catch (error) {
		log.error({ error, jobName }, "Failed to send heartbeat");
		return false;
	}
}
