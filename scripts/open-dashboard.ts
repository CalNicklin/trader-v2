/**
 * Opens the ops console dashboard via SSH tunnel.
 * Sets up a local port forward to the VPS, then opens the browser.
 *
 * Usage: bun run scripts/open-dashboard.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const envPath = join(import.meta.dir, "..", ".env");
const envContent = readFileSync(envPath, "utf-8");

function getVar(name: string, fallback?: string): string {
	const match = envContent.match(new RegExp(`^${name}=(.+)$`, "m"));
	const value = match?.[1]?.trim() ?? fallback;
	if (!value) throw new Error(`Missing ${name} in .env`);
	return value;
}

const vpsHost = getVar("VPS_HOST");
const vpsUser = getVar("VPS_USER");
const adminPassword = getVar("ADMIN_PASSWORD", "");
const localPort = 3847;

// Extract SSH key to temp file
const keyMatch = envContent.match(
	/VPS_SSH_KEY="?(-----BEGIN[\s\S]*?-----END[^\n]+)"?/,
);
if (!keyMatch?.[1]) throw new Error("Missing VPS_SSH_KEY in .env");

const keyFile = join(tmpdir(), `trader-v2-dash-${process.pid}.pem`);
Bun.write(keyFile, keyMatch[1] + "\n");
const { chmodSync } = await import("node:fs");
chmodSync(keyFile, 0o600);

// Clean up key file on exit
function cleanup() {
	try {
		const { unlinkSync } = require("node:fs");
		unlinkSync(keyFile);
	} catch {}
}
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

console.log(`Opening SSH tunnel to ${vpsHost}:3847 → localhost:${localPort}...`);

const tunnel = Bun.spawn([
	"ssh",
	"-i", keyFile,
	"-o", "StrictHostKeyChecking=no",
	"-o", "UserKnownHostsFile=/dev/null",
	"-o", "LogLevel=ERROR",
	"-N",
	"-L", `${localPort}:localhost:3847`,
	`${vpsUser}@${vpsHost}`,
], {
	stdout: "inherit",
	stderr: "inherit",
});

// Wait a moment for tunnel to establish, then open browser
await new Promise((r) => setTimeout(r, 1500));

const url = adminPassword
	? `http://admin:${encodeURIComponent(adminPassword)}@localhost:${localPort}/`
	: `http://localhost:${localPort}/`;

console.log(`Dashboard: http://localhost:${localPort}/`);
console.log("Press Ctrl+C to close tunnel.\n");

Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });

// Keep running until killed
await tunnel.exited;
cleanup();
