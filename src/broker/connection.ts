import { ConnectionState, IBApiNext } from "@stoqey/ib";
import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";

const log = createChildLogger({ module: "broker-connection" });

let _api: IBApiNext | null = null;
let _connected = false;
let _wasConnected = false;
let _disconnectAlerted = false;

/** Debounce reconnection handling to avoid flap storms during IB Gateway restarts. */
let _healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_STABLE_MS = 15_000;

export function getApi(): IBApiNext {
	if (!_api) {
		const config = getConfig();
		_api = new IBApiNext({
			host: config.IBKR_HOST,
			port: config.IBKR_PORT,
			reconnectInterval: 5000,
			connectionWatchdogInterval: 30,
			maxReqPerSec: 40,
		});
	}
	return _api;
}

export async function connect(): Promise<IBApiNext> {
	const api = getApi();
	const config = getConfig();

	const result = await withRetry(
		() =>
			new Promise<IBApiNext>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error("Connection timeout after 15s"));
				}, 15000);

				const sub = api.connectionState.subscribe((state) => {
					log.info({ state: ConnectionState[state] }, "Connection state changed");
					if (state === ConnectionState.Connected) {
						clearTimeout(timeout);
						sub.unsubscribe();
						resolve(api);
					}
				});

				api.connect(config.IBKR_CLIENT_ID);
			}),
		"IBKR connect",
		{ maxAttempts: 5, baseDelayMs: 3000 },
	);

	// Monitor connection state changes
	_connected = true;
	_wasConnected = true;
	_disconnectAlerted = false;

	api.connectionState.subscribe((state) => {
		if (state === ConnectionState.Disconnected) {
			_connected = false;

			if (_healthCheckTimer) {
				clearTimeout(_healthCheckTimer);
				_healthCheckTimer = null;
			}

			if (_wasConnected && !_disconnectAlerted) {
				_disconnectAlerted = true;
				log.error("IBKR connection lost after being connected");
			}
		} else if (state === ConnectionState.Connected) {
			const wasDisconnected = !_connected;
			_connected = true;

			if (wasDisconnected && _wasConnected) {
				log.info("IBKR connection re-established after disconnect");

				if (_healthCheckTimer) clearTimeout(_healthCheckTimer);
				_healthCheckTimer = setTimeout(() => {
					_healthCheckTimer = null;
					if (!_connected) return;

					_disconnectAlerted = false;
					api
						.getCurrentTime()
						.then((time: number) => {
							log.info({ serverTime: time }, "IBKR reconnection health check passed");
						})
						.catch((err: unknown) => {
							log.warn({ error: err }, "IBKR reconnection health check failed");
						});
				}, RECONNECT_STABLE_MS);
			}
		}
	});

	return result;
}

export async function disconnect(): Promise<void> {
	if (_api) {
		_api.disconnect();
		_api = null;
		_connected = false;
		log.info("Disconnected from IBKR");
	}
}

export function isConnected(): boolean {
	return _api !== null && _connected;
}

export function waitForConnection(timeoutMs = 60000): Promise<boolean> {
	if (_connected) return Promise.resolve(true);
	return new Promise((resolve) => {
		const start = Date.now();
		const interval = setInterval(() => {
			if (_connected) {
				clearInterval(interval);
				resolve(true);
			} else if (Date.now() - start >= timeoutMs) {
				clearInterval(interval);
				resolve(false);
			}
		}, 1000);
	});
}
