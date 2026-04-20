import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "catalyst-dispatcher" });

export const COOLDOWN_MS = 30 * 60 * 1000;
export const DAILY_CAP = 20;
export const DEBOUNCE_MS = 60 * 1000;

interface State {
	symbolCooldownUntil: Map<string, number>;
	lastDispatchedAt: Map<string, number>;
	dailyCount: { day: string; count: number };
	debounceTimers: Map<
		string,
		{ timer: ReturnType<typeof setTimeout>; newsEventId: number; exchange: string }
	>;
}

const state: State = {
	symbolCooldownUntil: new Map(),
	lastDispatchedAt: new Map(),
	dailyCount: { day: "", count: 0 },
	debounceTimers: new Map(),
};

function dayKey(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

export function resetCatalystStateForTesting(): void {
	for (const { timer } of state.debounceTimers.values()) {
		clearTimeout(timer);
	}
	state.symbolCooldownUntil.clear();
	state.lastDispatchedAt.clear();
	state.debounceTimers.clear();
	state.dailyCount = { day: "", count: 0 };
}

/** Returns true if the symbol can trigger a new catalyst dispatch at `now`. */
export function acceptsTrigger(symbol: string, now: number): boolean {
	const cooldownUntil = state.symbolCooldownUntil.get(symbol);
	if (cooldownUntil !== undefined && cooldownUntil > now) {
		log.debug({ symbol, cooldownUntil }, "Catalyst trigger blocked by cooldown");
		return false;
	}

	const today = dayKey(now);
	if (state.dailyCount.day !== today) {
		state.dailyCount = { day: today, count: 0 };
	}
	if (state.dailyCount.count >= DAILY_CAP) {
		log.warn({ symbol, dailyCount: state.dailyCount.count }, "Catalyst daily cap reached");
		return false;
	}

	return true;
}

/** Records that a catalyst dispatch fired for `symbol` at `now`. */
export function markDispatched(symbol: string, now: number): void {
	state.symbolCooldownUntil.set(symbol, now + COOLDOWN_MS);
	state.lastDispatchedAt.set(symbol, now);
	const today = dayKey(now);
	if (state.dailyCount.day !== today) {
		state.dailyCount = { day: today, count: 0 };
	}
	state.dailyCount.count++;
}

export function getCatalystMetrics(): {
	dispatchesToday: number;
	capHit: boolean;
	lastDispatchedAt: string | null;
} {
	const today = dayKey(Date.now());
	const count = state.dailyCount.day === today ? state.dailyCount.count : 0;
	let lastMs = 0;
	for (const stamped of state.lastDispatchedAt.values()) {
		if (stamped > lastMs) lastMs = stamped;
	}
	return {
		dispatchesToday: count,
		capHit: count >= DAILY_CAP,
		lastDispatchedAt: lastMs > 0 ? new Date(lastMs).toISOString() : null,
	};
}
