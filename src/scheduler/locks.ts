export type LockCategory =
	| "quotes_uk"
	| "quotes_us"
	| "news"
	| "eval_uk"
	| "eval_us"
	| "dispatch"
	| "analysis"
	| "risk"
	| "maintenance";

const locks = new Map<LockCategory, boolean>();

export function acquireLock(category: LockCategory): boolean {
	if (locks.get(category)) {
		return false;
	}
	locks.set(category, true);
	return true;
}

export function releaseLock(category: LockCategory): void {
	locks.set(category, false);
}

export function isLocked(category: LockCategory): boolean {
	return locks.get(category) === true;
}

export function resetAllLocks(): void {
	locks.clear();
}
