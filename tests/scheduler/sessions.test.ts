import { describe, test, expect } from "bun:test";
import {
	getCurrentSession,
	isExchangeOpen,
	type SessionName,
	UK_EXCHANGES,
	US_EXCHANGES,
} from "../../src/scheduler/sessions";

describe("getCurrentSession", () => {
	test("returns pre_market at 06:30 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T06:30:00+01:00"));
		expect(session.name).toBe("pre_market");
		expect(session.exchanges).toEqual([]);
		expect(session.allowNewEntries).toBe(false);
	});

	test("returns uk_session at 09:00 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T09:00:00+01:00"));
		expect(session.name).toBe("uk_session");
		expect(session.exchanges).toEqual(UK_EXCHANGES);
		expect(session.allowNewEntries).toBe(true);
	});

	test("returns overlap at 15:00 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T15:00:00+01:00"));
		expect(session.name).toBe("overlap");
		expect(session.exchanges).toEqual([...UK_EXCHANGES, ...US_EXCHANGES]);
		expect(session.allowNewEntries).toBe(true);
	});

	test("returns us_session at 17:00 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T17:00:00+01:00"));
		expect(session.name).toBe("us_session");
		expect(session.exchanges).toEqual(US_EXCHANGES);
		expect(session.allowNewEntries).toBe(true);
	});

	test("returns us_close at 21:05 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T21:05:00+01:00"));
		expect(session.name).toBe("us_close");
		expect(session.exchanges).toEqual(US_EXCHANGES);
		expect(session.allowNewEntries).toBe(false);
	});

	test("returns post_close at 22:30 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T22:30:00+01:00"));
		expect(session.name).toBe("post_close");
		expect(session.exchanges).toEqual([]);
		expect(session.allowNewEntries).toBe(false);
	});

	test("returns off_hours at 03:00 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T03:00:00+01:00"));
		expect(session.name).toBe("off_hours");
		expect(session.exchanges).toEqual([]);
		expect(session.allowNewEntries).toBe(false);
	});

	test("returns off_hours on Saturday", () => {
		const session = getCurrentSession(new Date("2026-04-11T10:00:00+01:00"));
		expect(session.name).toBe("off_hours");
	});

	test("returns off_hours on Sunday", () => {
		const session = getCurrentSession(new Date("2026-04-12T10:00:00+01:00"));
		expect(session.name).toBe("off_hours");
	});

	test("boundary: 08:00 exactly is uk_session", () => {
		const session = getCurrentSession(new Date("2026-04-08T08:00:00+01:00"));
		expect(session.name).toBe("uk_session");
	});

	test("boundary: 14:30 exactly is overlap", () => {
		const session = getCurrentSession(new Date("2026-04-08T14:30:00+01:00"));
		expect(session.name).toBe("overlap");
	});

	test("boundary: 16:30 exactly is us_session", () => {
		const session = getCurrentSession(new Date("2026-04-08T16:30:00+01:00"));
		expect(session.name).toBe("us_session");
	});

	test("boundary: 21:00 exactly is us_close", () => {
		const session = getCurrentSession(new Date("2026-04-08T21:00:00+01:00"));
		expect(session.name).toBe("us_close");
	});

	test("boundary: 21:15 exactly is post_close (us_close ends)", () => {
		const session = getCurrentSession(new Date("2026-04-08T21:15:00+01:00"));
		expect(session.name).toBe("post_close");
	});

	test("boundary: 22:00 exactly is post_close", () => {
		const session = getCurrentSession(new Date("2026-04-08T22:00:00+01:00"));
		expect(session.name).toBe("post_close");
	});

	test("boundary: 22:46 exactly is off_hours", () => {
		const session = getCurrentSession(new Date("2026-04-08T22:46:00+01:00"));
		expect(session.name).toBe("off_hours");
	});

	test("uses current time when no argument given", () => {
		const session = getCurrentSession();
		expect(session.name).toBeDefined();
		expect(Array.isArray(session.exchanges)).toBe(true);
		expect(typeof session.allowNewEntries).toBe("boolean");
	});
});

describe("isExchangeOpen", () => {
	test("LSE is open during uk_session", () => {
		expect(isExchangeOpen("LSE", new Date("2026-04-08T09:00:00+01:00"))).toBe(true);
	});

	test("NASDAQ is not open during uk_session", () => {
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-08T09:00:00+01:00"))).toBe(false);
	});

	test("NASDAQ is open during overlap", () => {
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-08T15:00:00+01:00"))).toBe(true);
	});

	test("LSE is open during overlap", () => {
		expect(isExchangeOpen("LSE", new Date("2026-04-08T15:00:00+01:00"))).toBe(true);
	});

	test("NASDAQ is open during us_session", () => {
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-08T17:00:00+01:00"))).toBe(true);
	});

	test("LSE is not open during us_session", () => {
		expect(isExchangeOpen("LSE", new Date("2026-04-08T17:00:00+01:00"))).toBe(false);
	});

	test("NASDAQ is open during us_close", () => {
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-08T21:05:00+01:00"))).toBe(true);
	});

	test("nothing is open on weekends", () => {
		expect(isExchangeOpen("LSE", new Date("2026-04-11T10:00:00+01:00"))).toBe(false);
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-11T10:00:00+01:00"))).toBe(false);
	});
});
