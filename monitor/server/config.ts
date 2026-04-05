import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface MonitorConfig {
	vpsHost: string;
	vpsUser: string;
	vpsSshKey: string;
	githubToken: string;
	githubRepo: string;
	adminPassword: string;
	port: number;
}

export function loadConfig(): MonitorConfig {
	const envPath = join(import.meta.dir, "..", "..", ".env");
	const envContent = readFileSync(envPath, "utf-8");

	function getVar(name: string, fallback?: string): string {
		const match = envContent.match(new RegExp(`^${name}=(.+)$`, "m"));
		const value = match?.[1]?.trim() ?? fallback;
		if (value === undefined || value === null)
			throw new Error(`Missing ${name} in .env`);
		return value;
	}

	// Extract multi-line SSH key (same regex as vps-ssh.sh)
	const keyMatch = envContent.match(
		/VPS_SSH_KEY="?(-----BEGIN[\s\S]*?-----END[^\n]+)"?/,
	);
	if (!keyMatch?.[1]) throw new Error("Missing VPS_SSH_KEY in .env");

	return {
		vpsHost: getVar("VPS_HOST"),
		vpsUser: getVar("VPS_USER"),
		vpsSshKey: keyMatch[1],
		githubToken: getVar("GITHUB_TOKEN", ""),
		githubRepo:
			getVar("GITHUB_REPO_OWNER", "CalNicklin") +
			"/" +
			getVar("GITHUB_REPO_NAME", "trader-v2"),
		adminPassword: getVar("ADMIN_PASSWORD", ""),
		port: Number.parseInt(getVar("HTTP_PORT", "3848"), 10),
	};
}
