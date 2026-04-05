import { useEffect, useRef, useState, useCallback } from "react";

export interface LogState {
	lines: string[];
	connected: boolean;
}

const MAX_LINES = 5000;

export function useLogs(): LogState {
	const [lines, setLines] = useState<string[]>([]);
	const [connected, setConnected] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const connect = useCallback(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws/logs`);
		wsRef.current = ws;

		ws.onopen = () => setConnected(true);

		ws.onmessage = (event) => {
			const data = event.data as string;
			// Check for disconnect signal
			try {
				const parsed = JSON.parse(data);
				if (parsed.type === "disconnect") {
					setConnected(false);
					return;
				}
			} catch {
				// Not JSON — it's a log line
			}
			setLines((prev) => {
				const next = [...prev, data];
				return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
			});
		};

		ws.onclose = () => {
			setConnected(false);
			wsRef.current = null;
			reconnectTimer.current = setTimeout(connect, 3000);
		};

		ws.onerror = () => {
			ws.close();
		};
	}, []);

	useEffect(() => {
		connect();
		return () => {
			if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
			wsRef.current?.close();
		};
	}, [connect]);

	return { lines, connected };
}
