import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getConfig } from "./config.ts";
import { closeDb, getDb } from "./db/client.ts";
import { sendEmail } from "./reporting/email.ts";
import { startScheduler, stopScheduler } from "./scheduler/cron.ts";
import { getLogger } from "./utils/logger.ts";

const log = getLogger();

async function boot() {
	const config = getConfig();
	log.info({ env: config.NODE_ENV }, "Trader v2 starting");

	// Initialize database and run migrations
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
	log.info("Database connected and migrated");

	// Ensure seed strategies exist
	const { ensureSeedStrategies } = await import("./strategy/seed.ts");
	await ensureSeedStrategies();
	log.info("Seed strategies verified");

	// Start the scheduler
	startScheduler();
	log.info("Scheduler started — trader v2 is running");

	// Start HTTP server
	const { startServer } = await import("./monitoring/server.ts");
	startServer(config.HTTP_PORT);
	log.info({ port: config.HTTP_PORT }, "Health endpoint available");
}

async function shutdown(signal: string) {
	log.info({ signal }, "Shutting down...");
	stopScheduler();
	const { stopServer } = await import("./monitoring/server.ts");
	stopServer();
	closeDb();
	log.info("Shutdown complete");
	process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (error) => {
	log.fatal({ error }, "Uncaught exception");
	sendEmail({
		subject: "CRITICAL: Trader v2 uncaught exception",
		html: `<pre>${String(error?.stack ?? error)}</pre>`,
	}).finally(() => shutdown("uncaughtException"));
});

process.on("unhandledRejection", (reason) => {
	log.error({ reason }, "Unhandled rejection");
});

boot().catch(async (error) => {
	log.fatal({ error }, "Boot failed");
	await sendEmail({
		subject: "CRITICAL: Trader v2 boot failed",
		html: `<pre>${String(error?.stack ?? error)}</pre>`,
	});
	process.exit(1);
});
