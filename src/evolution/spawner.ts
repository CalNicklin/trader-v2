import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { strategies, strategyMutations } from "../db/schema";
import type { ValidatedMutation } from "./types";

export async function spawnChild(mutation: ValidatedMutation): Promise<number> {
	const db = getDb();

	// 1. Fetch parent strategy
	const [parent] = await db
		.select()
		.from(strategies)
		.where(eq(strategies.id, mutation.parentId))
		.limit(1);

	if (!parent) {
		throw new Error(`Parent strategy ${mutation.parentId} not found`);
	}

	// 2. Insert new child strategy
	const [child] = await db
		.insert(strategies)
		.values({
			name: mutation.name,
			description: mutation.description,
			parameters: JSON.stringify(mutation.parameters),
			signals: JSON.stringify(mutation.signals),
			universe: JSON.stringify(mutation.universe),
			status: "paper" as const,
			virtualBalance: parent.virtualBalance,
			parentStrategyId: parent.id,
			generation: parent.generation + 1,
			createdBy: "evolution",
		})
		.returning();

	if (!child) {
		throw new Error("Failed to insert child strategy");
	}

	// 3. Record lineage in strategyMutations
	await db.insert(strategyMutations).values({
		parentId: parent.id,
		childId: child.id,
		mutationType: mutation.type as "parameter_tweak" | "new_variant" | "code_change" | "structural",
		parameterDiff: JSON.stringify(mutation.parameterDiff),
	});

	return child.id;
}
