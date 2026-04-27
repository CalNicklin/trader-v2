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

	// Connect to IBKR on every boot — UK quote path (LSE/AIM via ibkrQuote)
	// needs the broker connection regardless of LIVE_TRADING_ENABLED.
	// Order monitoring only starts when the live-trading flag is on.
	try {
		const { connect, waitForConnection } = await import("./broker/connection.ts");

		log.info("Connecting to IBKR for market data...");
		await connect();

		const connected = await waitForConnection(30000);
		if (connected) {
			log.info("IBKR connected");
			if (config.LIVE_TRADING_ENABLED) {
				const { startOrderMonitoring } = await import("./broker/order-monitor.ts");
				const { getApi } = await import("./broker/connection.ts");
				const { getDb: getDatabase } = await import("./db/client.ts");
				startOrderMonitoring(getApi(), getDatabase());
				log.info("Live trading enabled — order monitoring started");
			}
		} else {
			log.warn("IBKR connection timeout — scheduler jobs will check connection");
		}
	} catch (err) {
		log.error({ error: err }, "IBKR connection failed — scheduler will retry on next tick");
	}

	// Run position reconciliation on boot
	if (config.LIVE_TRADING_ENABLED) {
		try {
			const { isConnected } = await import("./broker/connection.ts");
			if (isConnected()) {
				const { getPositions } = await import("./broker/account.ts");
				const { reconcilePositions } = await import("./live/reconciliation.ts");
				const ibkrPositions = await getPositions();
				await reconcilePositions(ibkrPositions);
			}
		} catch (err) {
			log.warn({ error: err }, "Position reconciliation on boot failed (non-fatal)");
		}
	}

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
	try {
		const { stopOrderMonitoring } = await import("./broker/order-monitor.ts");
		const { disconnect } = await import("./broker/connection.ts");
		stopOrderMonitoring();
		await disconnect();
	} catch {
		// Broker modules may not be loaded if live trading was disabled
	}
	const { stopServer } = await import("./monitoring/server.ts");
	await stopServer();
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
