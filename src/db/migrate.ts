import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./client.ts";

const db = getDb();
migrate(db, { migrationsFolder: "./drizzle/migrations" });
console.log("Migrations complete");
