import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { gateDiagnostic } from "../db/schema.ts";
import { isExchangeOpen } from "../scheduler/sessions.ts";
import {
	AI_SEMI_GATE_NAME,
	AI_SEMI_SENTINEL_AFTER_DAYS,
	computeAvgMovePct,
	type GateFireContext,
	meetsHitThreshold,
	shouldFireAiSemiGate,
	snapshotBasket,
} from "../universe/ai-semi-basket.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "ai-semi-observer" });

/**
 * Observer hook — called synchronously from the news-ingest pipeline after a
 * classifier result is written. If the event qualifies as a gate fire,
 * snapshots the basket and inserts a `gate_diagnostic` row.
 *
 * Never throws — observer failures are logged and swallowed so an instrumentation
 * bug cannot break the ingest critical path.
 */
export async function observeAiSemiGate(ctx: GateFireContext): Promise<void> {
	if (!shouldFireAiSemiGate(ctx)) return;
	try {
		const snapshot = await snapshotBasket();
		const db = getDb();
		await db.insert(gateDiagnostic).values({
			gateName: AI_SEMI_GATE_NAME,
			triggerSymbol: ctx.triggerSymbol,
			triggerNewsEventId: ctx.triggerNewsEventId,
			firedAt: new Date().toISOString(),
			basketSnapshotAtFire: JSON.stringify(snapshot),
		});
		log.info({ gate: AI_SEMI_GATE_NAME, triggerSymbol: ctx.triggerSymbol }, "AI-semi gate fired");
	} catch (err) {
		log.error({ err, triggerSymbol: ctx.triggerSymbol }, "AI-semi gate observer failed");
	}
}

/**
 * Count trading days between two dates (inclusive of neither end). Uses the
 * US session calendar via `isExchangeOpen` at noon UTC on each candidate day.
 * Crude but sufficient for 5-day horizon accounting.
 */
function tradingDaysBetween(from: Date, to: Date): number {
	if (to.getTime() <= from.getTime()) return 0;
	let count = 0;
	const dayMs = 24 * 60 * 60 * 1000;
	const start = new Date(from.getTime() + dayMs);
	for (let ts = start.getTime(); ts <= to.getTime(); ts += dayMs) {
		const probe = new Date(ts);
		probe.setUTCHours(15, 30, 0, 0); // NASDAQ mid-session in UTC
		if (isExchangeOpen("NASDAQ", probe)) count++;
	}
	return count;
}

export interface MeasurementSweepResult {
	measured: number;
	quarantined: number;
	stillPending: number;
}

/**
 * Nightly sweep — scans for unmeasured rows that have aged past the 5-trading-day
 * window and fills in the T+5d snapshot + avg move. Rows older than the
 * sentinel window (see `AI_SEMI_SENTINEL_AFTER_DAYS`) get `measuredAt` set
 * with `basketHitThreshold = null` so they don't retry forever.
 */
export async function runAiSemiMeasurementSweep(
	now: Date = new Date(),
): Promise<MeasurementSweepResult> {
	const db = getDb();
	const pending = await db
		.select()
		.from(gateDiagnostic)
		.where(and(eq(gateDiagnostic.gateName, AI_SEMI_GATE_NAME), isNull(gateDiagnostic.measuredAt)));

	let measured = 0;
	let quarantined = 0;
	let stillPending = 0;

	for (const row of pending) {
		const firedAt = new Date(row.firedAt);
		const tradingDays = tradingDaysBetween(firedAt, now);
		const calendarDays = (now.getTime() - firedAt.getTime()) / (24 * 60 * 60 * 1000);

		if (tradingDays < 5 && calendarDays < AI_SEMI_SENTINEL_AFTER_DAYS) {
			stillPending++;
			continue;
		}

		if (calendarDays >= AI_SEMI_SENTINEL_AFTER_DAYS && tradingDays < 5) {
			// Quarantine: too old, still under window — usually means we missed
			// the measurement for some reason. Close it out with a sentinel.
			await db
				.update(gateDiagnostic)
				.set({
					measuredAt: now.toISOString(),
					basketHitThreshold: null,
					basketAvgMovePct: null,
				})
				.where(eq(gateDiagnostic.id, row.id));
			quarantined++;
			log.warn({ id: row.id, firedAt: row.firedAt }, "AI-semi gate quarantined past sentinel");
			continue;
		}

		// Normal measurement path
		const snapshotAt5d = await snapshotBasket();
		const snapshotAtFire = JSON.parse(row.basketSnapshotAtFire) as Record<string, number | null>;
		const avgMove = computeAvgMovePct(snapshotAtFire, snapshotAt5d);
		const hit = meetsHitThreshold(avgMove);

		await db
			.update(gateDiagnostic)
			.set({
				basketSnapshotAt5d: JSON.stringify(snapshotAt5d),
				basketAvgMovePct: avgMove,
				basketHitThreshold: avgMove == null ? null : hit,
				measuredAt: now.toISOString(),
			})
			.where(eq(gateDiagnostic.id, row.id));
		measured++;
	}

	if (measured + quarantined > 0) {
		log.info({ measured, quarantined, stillPending }, "AI-semi measurement sweep complete");
	}

	return { measured, quarantined, stillPending };
}

/**
 * Aggregate fire/hit counts for the dashboard tile. Window defaults to the
 * last 21 days (the pre-registered observation horizon).
 */
export async function getAiSemiObservationSummary(now: Date = new Date()): Promise<{
	gateFiresInWindow: number;
	measuredInWindow: number;
	hitsInWindow: number;
	pendingMeasurement: number;
	daysElapsedOfWindow: number;
}> {
	const db = getDb();
	const windowDays = 21;
	const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();

	const fires = await db
		.select({ count: sql<number>`count(*)` })
		.from(gateDiagnostic)
		.where(
			and(
				eq(gateDiagnostic.gateName, AI_SEMI_GATE_NAME),
				sql`${gateDiagnostic.firedAt} >= ${windowStart}`,
			),
		);

	const measured = await db
		.select({ count: sql<number>`count(*)` })
		.from(gateDiagnostic)
		.where(
			and(
				eq(gateDiagnostic.gateName, AI_SEMI_GATE_NAME),
				sql`${gateDiagnostic.firedAt} >= ${windowStart}`,
				sql`${gateDiagnostic.measuredAt} IS NOT NULL`,
				sql`${gateDiagnostic.basketHitThreshold} IS NOT NULL`,
			),
		);

	const hits = await db
		.select({ count: sql<number>`count(*)` })
		.from(gateDiagnostic)
		.where(
			and(
				eq(gateDiagnostic.gateName, AI_SEMI_GATE_NAME),
				sql`${gateDiagnostic.firedAt} >= ${windowStart}`,
				eq(gateDiagnostic.basketHitThreshold, true),
			),
		);

	const pending = await db
		.select({ count: sql<number>`count(*)` })
		.from(gateDiagnostic)
		.where(
			and(
				eq(gateDiagnostic.gateName, AI_SEMI_GATE_NAME),
				sql`${gateDiagnostic.firedAt} >= ${windowStart}`,
				isNull(gateDiagnostic.measuredAt),
			),
		);

	// Days elapsed: how long the oldest in-window fire is, capped at 21.
	const earliest = await db
		.select({ firedAt: gateDiagnostic.firedAt })
		.from(gateDiagnostic)
		.where(
			and(
				eq(gateDiagnostic.gateName, AI_SEMI_GATE_NAME),
				sql`${gateDiagnostic.firedAt} >= ${windowStart}`,
			),
		)
		.orderBy(gateDiagnostic.firedAt)
		.limit(1);

	const daysElapsed = earliest[0]
		? Math.min(
				windowDays,
				Math.ceil(
					(now.getTime() - new Date(earliest[0].firedAt).getTime()) / (24 * 60 * 60 * 1000),
				),
			)
		: 0;

	return {
		gateFiresInWindow: fires[0]?.count ?? 0,
		measuredInWindow: measured[0]?.count ?? 0,
		hitsInWindow: hits[0]?.count ?? 0,
		pendingMeasurement: pending[0]?.count ?? 0,
		daysElapsedOfWindow: daysElapsed,
	};
}
