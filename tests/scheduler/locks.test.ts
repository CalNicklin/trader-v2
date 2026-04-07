import { beforeEach, describe, expect, test } from "bun:test";
import {
	acquireLock,
	isLocked,
	type LockCategory,
	releaseLock,
	resetAllLocks,
} from "../../src/scheduler/locks";

describe("per-category locks", () => {
	beforeEach(() => {
		resetAllLocks();
	});

	test("lock is not held initially", () => {
		expect(isLocked("quotes_uk")).toBe(false);
	});

	test("acquireLock returns true when lock is free", () => {
		expect(acquireLock("quotes_uk")).toBe(true);
		expect(isLocked("quotes_uk")).toBe(true);
	});

	test("acquireLock returns false when lock is already held", () => {
		acquireLock("quotes_uk");
		expect(acquireLock("quotes_uk")).toBe(false);
	});

	test("releaseLock frees the lock", () => {
		acquireLock("quotes_uk");
		releaseLock("quotes_uk");
		expect(isLocked("quotes_uk")).toBe(false);
	});

	test("different categories are independent", () => {
		acquireLock("quotes_uk");
		expect(acquireLock("quotes_us")).toBe(true);
		expect(isLocked("quotes_uk")).toBe(true);
		expect(isLocked("quotes_us")).toBe(true);
	});

	test("UK quotes lock does not block US eval", () => {
		acquireLock("quotes_uk");
		expect(acquireLock("eval_us")).toBe(true);
	});

	test("same category blocks: two UK quote jobs cannot overlap", () => {
		acquireLock("quotes_uk");
		expect(acquireLock("quotes_uk")).toBe(false);
	});

	test("resetAllLocks clears all held locks", () => {
		acquireLock("quotes_uk");
		acquireLock("quotes_us");
		acquireLock("news");
		resetAllLocks();
		expect(isLocked("quotes_uk")).toBe(false);
		expect(isLocked("quotes_us")).toBe(false);
		expect(isLocked("news")).toBe(false);
	});

	test("all lock categories can be acquired independently", () => {
		const categories: LockCategory[] = [
			"quotes_uk",
			"quotes_us",
			"news",
			"eval_uk",
			"eval_us",
			"dispatch",
			"analysis",
			"risk",
			"maintenance",
		];
		for (const cat of categories) {
			expect(acquireLock(cat)).toBe(true);
		}
		for (const cat of categories) {
			expect(isLocked(cat)).toBe(true);
		}
	});
});
