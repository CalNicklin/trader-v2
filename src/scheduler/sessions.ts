import type { Exchange } from "../broker/contracts.ts";

export type SessionName =
	| "pre_market"
	| "uk_session"
	| "overlap"
	| "us_session"
	| "us_close"
	| "post_close"
	| "off_hours";

export interface Session {
	name: SessionName;
	exchanges: Exchange[];
	allowNewEntries: boolean;
}

export const UK_EXCHANGES: Exchange[] = ["LSE"];
export const US_EXCHANGES: Exchange[] = ["NASDAQ", "NYSE"];

interface SessionDef {
	name: SessionName;
	startHour: number;
	startMinute: number;
	endHour: number;
	endMinute: number;
	exchanges: Exchange[];
	allowNewEntries: boolean;
}

const SESSION_DEFS: SessionDef[] = [
	{
		name: "pre_market",
		startHour: 6,
		startMinute: 0,
		endHour: 8,
		endMinute: 0,
		exchanges: [],
		allowNewEntries: false,
	},
	{
		name: "uk_session",
		startHour: 8,
		startMinute: 0,
		endHour: 14,
		endMinute: 30,
		exchanges: ["LSE"],
		allowNewEntries: true,
	},
	{
		name: "overlap",
		startHour: 14,
		startMinute: 30,
		endHour: 16,
		endMinute: 30,
		exchanges: ["LSE", "NASDAQ", "NYSE"],
		allowNewEntries: true,
	},
	{
		name: "us_session",
		startHour: 16,
		startMinute: 30,
		endHour: 21,
		endMinute: 0,
		exchanges: ["NASDAQ", "NYSE"],
		allowNewEntries: true,
	},
	{
		name: "us_close",
		startHour: 21,
		startMinute: 0,
		endHour: 21,
		endMinute: 15,
		exchanges: ["NASDAQ", "NYSE"],
		allowNewEntries: false,
	},
	{
		name: "post_close",
		startHour: 21,
		startMinute: 15,
		endHour: 22,
		endMinute: 46,
		exchanges: [],
		allowNewEntries: false,
	},
];

function toUkTime(date: Date): { hour: number; minute: number; dayOfWeek: number } {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/London",
		hour: "numeric",
		minute: "numeric",
		hour12: false,
	}).formatToParts(date);

	const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
	const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);

	const dayStr = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/London",
		weekday: "short",
	}).format(date);
	const dayMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};
	const dayOfWeek = dayMap[dayStr] ?? 0;

	return { hour, minute, dayOfWeek };
}

function timeToMinutes(hour: number, minute: number): number {
	return hour * 60 + minute;
}

export function getCurrentSession(now?: Date): Session {
	const date = now ?? new Date();
	const { hour, minute, dayOfWeek } = toUkTime(date);

	if (dayOfWeek === 0 || dayOfWeek === 6) {
		return { name: "off_hours", exchanges: [], allowNewEntries: false };
	}

	const currentMinutes = timeToMinutes(hour, minute);

	for (const def of SESSION_DEFS) {
		const start = timeToMinutes(def.startHour, def.startMinute);
		const end = timeToMinutes(def.endHour, def.endMinute);
		if (currentMinutes >= start && currentMinutes < end) {
			return {
				name: def.name,
				exchanges: def.exchanges,
				allowNewEntries: def.allowNewEntries,
			};
		}
	}

	return { name: "off_hours", exchanges: [], allowNewEntries: false };
}

export function isExchangeOpen(exchange: Exchange, now?: Date): boolean {
	const session = getCurrentSession(now);
	return session.exchanges.includes(exchange);
}
