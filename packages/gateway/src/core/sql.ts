// What the ledger needs from its host: a synchronous SQLite connection, somewhere to put ping
// bodies too large for a row, and one alarm. The Worker's ledger Durable Object provides them
// from its storage and R2 (worker/storage.ts), the Node host from node:sqlite and a timer
// (node/sqlite.ts, node/gateway.ts). Nothing in the core names either host.

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlStore {
  /** Runs one statement: the rows it returns (a read, or RETURNING), [] for any other write. */
  exec<T extends SqlRow = SqlRow>(query: string, ...params: SqlValue[]): T[];
  /** Runs `fn` in one transaction: every write in it lands, or none does. */
  transaction<T>(fn: () => T): T;
}

/** Large values kept outside SQLite (the Worker's R2 bucket). */
export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The value as text, or null when it is gone. */
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/** The one alarm the ledger sets for its next piece of work; the host calls `tick` when it fires. */
export interface Alarm {
  get(): Promise<number | null>;
  set(at: number): Promise<void>;
}
