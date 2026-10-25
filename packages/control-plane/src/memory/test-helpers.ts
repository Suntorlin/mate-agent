/**
 * Shared set-up for the user memory suites. Each suite opens its own
 * migrated SQLite database (only test files may import the Node adapter or
 * Node built-ins) and builds the service over it here.
 */

import type { SqlDatabase } from "../db/sql-database";
import { UserMemoryService } from "./service";
import { UserMemoryStore } from "./store";

export async function seedUsers(db: SqlDatabase, userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) {
    await db
      .prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 0, 0)")
      .bind(userId)
      .run();
  }
}

/** A service over `db` whose clock is `clock.now` and whose ids count up. */
export function memoryServiceFor(
  db: SqlDatabase,
  clock: { now: number }
): { service: UserMemoryService; store: UserMemoryStore } {
  let ids = 0;
  const store = new UserMemoryStore(db);
  const service = new UserMemoryService({
    store,
    now: () => clock.now,
    generateId: () => `id${String(++ids).padStart(4, "0")}`,
  });
  return { service, store };
}
