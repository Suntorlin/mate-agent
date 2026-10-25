// The core's storage ports over a Durable Object's storage and an R2 bucket.
import type { Alarm, BlobStore, SqlStore, SqlValue } from "../core/sql";

export function durableSql(storage: DurableObjectStorage): SqlStore {
  return {
    exec: <T>(query: string, ...params: SqlValue[]) =>
      storage.sql.exec(query, ...params).toArray() as T[],
    transaction: (fn) => storage.transactionSync(fn),
  };
}

export function durableAlarm(storage: DurableObjectStorage): Alarm {
  return {
    get: () => storage.getAlarm(),
    set: (at) => storage.setAlarm(at),
  };
}

export function r2Blobs(bucket: R2Bucket | undefined): BlobStore | undefined {
  if (!bucket) return undefined;
  return {
    put: async (key, bytes) => {
      await bucket.put(key, bytes);
    },
    get: async (key) => {
      const object = await bucket.get(key);
      return object ? object.text() : null;
    },
    delete: (key) => bucket.delete(key),
  };
}
