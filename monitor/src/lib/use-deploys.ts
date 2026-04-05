import { useEffect, useState } from "react";

export interface DeployRun {
	id: number;
	status: string;
	conclusion: string | null;
	headSha: string;
	headMessage: string;
	createdAt: string;
	updatedAt: string;
	htmlUrl: string;
	runDurationMs: number | null;
}

export function useDeploys(intervalMs = 60_000): DeployRun[] {
	const [deploys, setDeploys] = useState<DeployRun[]>([]);

	useEffect(() => {
		async function poll() {
			try {
				const res = await fetch("/api/deploys");
				if (res.ok) {
					setDeploys((await res.json()) as DeployRun[]);
				}
			} catch {
				// Ignore fetch errors
			}
		}

		poll();
		const id = setInterval(poll, intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);

	return deploys;
}
