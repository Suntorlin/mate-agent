// The core's SqlStore over node:sqlite: one file (or ":memory:"), one synchronous connection.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlStore } from "../core/sql";

export interface NodeSqlStore extends SqlStore {
  close(): void;
}

export function openSqlite(path: string): NodeSqlStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  const statements = new Map<string, StatementSync>();
  const prepare = (query: string): StatementSync => {
    let statement = statements.get(query);
    if (!statement) {
      statement = db.prepare(query);
      statements.set(query, statement);
    }
    return statement;
  };
  return {
    // Stepping to completion returns the rows of a read or a RETURNING clause, and an empty list
    // for any other statement.
    exec: <T>(query: string, ...params: Array<string | number | null>) =>
      prepare(query).all(...params) as T[],
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
