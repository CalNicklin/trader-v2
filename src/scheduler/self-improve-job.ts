import { getConfig } from "../config";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "self-improve-job" });

export async function runSelfImproveJob(): Promise<void> {
	const config = getConfig();

	if (!config.GITHUB_TOKEN) {
		log.info("GITHUB_TOKEN not set, skipping self-improvement dispatch");
		return;
	}

	if (!config.GITHUB_REPO_OWNER || !config.GITHUB_REPO_NAME) {
		log.info("GitHub repo not configured, skipping self-improvement dispatch");
		return;
	}

	try {
		const repo = `${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}`;
		const proc = Bun.spawn(["gh", "workflow", "run", "claude.yml", "--repo", repo], {
			env: { ...process.env, GH_TOKEN: config.GITHUB_TOKEN },
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();

		if (exitCode !== 0) {
			log.error({ exitCode, stderr }, "Failed to dispatch self-improvement workflow");
			return;
		}

		log.info({ repo }, "Self-improvement workflow dispatched");
	} catch (error) {
		log.error({ error }, "Self-improvement dispatch failed");
		throw error;
	}
}
