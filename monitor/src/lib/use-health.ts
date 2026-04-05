import { useEffect, useState } from "react";

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

export interface HealthState {
	data: HealthData | null;
	error: boolean;
}

export function useHealth(intervalMs = 30_000): HealthState {
	const [data, setData] = useState<HealthData | null>(null);
	const [error, setError] = useState(false);

	useEffect(() => {
		async function poll() {
			try {
				const res = await fetch("/api/health");
				if (!res.ok) {
					setError(true);
					setData(null);
					return;
				}
				const json = (await res.json()) as HealthData;
				setData(json);
				setError(false);
			} catch {
				setError(true);
				setData(null);
			}
		}

		poll();
		const id = setInterval(poll, intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);

	return { data, error };
}
