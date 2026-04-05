import type { MonitorConfig } from "./config.ts";

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

export async function fetchDeploys(config: MonitorConfig): Promise<DeployRun[]> {
	if (!config.githubToken) return [];

	const url = `https://api.github.com/repos/${config.githubRepo}/actions/workflows/deploy.yml/runs?per_page=5`;
	try {
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${config.githubToken}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return [];
		const data = (await res.json()) as {
			workflow_runs: Array<{
				id: number;
				status: string;
				conclusion: string | null;
				head_sha: string;
				head_commit?: { message?: string };
				created_at: string;
				updated_at: string;
				html_url: string;
				run_started_at?: string;
			}>;
		};
		return data.workflow_runs.map((run) => ({
			id: run.id,
			status: run.status,
			conclusion: run.conclusion,
			headSha: run.head_sha,
			headMessage: run.head_commit?.message?.split("\n")[0] ?? "",
			createdAt: run.created_at,
			updatedAt: run.updated_at,
			htmlUrl: run.html_url,
			runDurationMs:
				run.run_started_at
					? new Date(run.updated_at).getTime() -
						new Date(run.run_started_at).getTime()
					: null,
		}));
	} catch {
		return [];
	}
}
