/**
 * The daily clean-up of user memory (docs/USER_MEMORY.md): a key forgotten
 * (or lapsed) USER_MEMORY_FORGOTTEN_RETENTION_MS ago is deleted with all its
 * versions, and ops older than USER_MEMORY_OP_RETENTION_MS are deleted.
 * Until then a forgotten entry can still be brought back and is exported.
 */

import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import { UserMemoryStore } from "./store";

/** Daily, at 03:41 UTC: off the hour, away from the other jobs' slots. */
export const USER_MEMORY_PURGE_CRON = "41 3 * * *";

export async function purgeUserMemory(db: SqlDatabase, log: Logger, nowMs: number): Promise<void> {
  const purged = await new UserMemoryStore(db).purge(nowMs);
  log.info("user_memory.purged", {
    event: "user_memory.purged",
    entries: purged.entries,
    ops: purged.ops,
  });
}
