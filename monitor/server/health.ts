import type { MonitorConfig } from "./config.ts";

export interface HealthData {
	status: "ok" | "degraded" | "error";
	uptime: number;
	timestamp: string;
	activeStrategies: number;
	dailyPnl: number;
	apiSpendToday: number;
	lastQuoteTime: string | null;
	paused: boolean;
}

export async function fetchHealth(
	config: MonitorConfig,
): Promise<HealthData | null> {
	const url = `http://${config.vpsHost}:3847/health`;
	try {
		const headers: Record<string, string> = {};
		if (config.adminPassword) {
			headers.Authorization = `Basic ${btoa(`:${config.adminPassword}`)}`;
		}
		const res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		return (await res.json()) as HealthData;
	} catch {
		return null;
	}
}
