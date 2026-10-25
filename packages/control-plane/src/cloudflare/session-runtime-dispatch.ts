import type { SessionRuntimeDispatch } from "../session/runtime-client";

/** The regions Cloudflare accepts as a hint for where a new Durable Object is created. */
const LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const;
export type DurableObjectLocationHint = (typeof LOCATION_HINTS)[number];

/**
 * The configured region hint, or none. A value that is not a region fails loudly: a typo would
 * otherwise leave every session object wherever the first request happened to land.
 */
export function parseLocationHint(
  value: string | undefined
): DurableObjectLocationHint | undefined {
  if (!value) return undefined;
  if (!(LOCATION_HINTS as readonly string[]).includes(value)) {
    throw new Error(
      `SESSION_DO_LOCATION_HINT must be one of ${LOCATION_HINTS.join(", ")} (got ${value})`
    );
  }
  return value as DurableObjectLocationHint;
}

/**
 * The Durable Object that holds `sessionId`. The hint only matters when the object is first
 * created (it keeps the object near the database, bucket and sandboxes); an existing object stays
 * where it is.
 */
export function sessionObject(
  namespace: DurableObjectNamespace,
  sessionId: string,
  locationHint?: DurableObjectLocationHint
): DurableObjectStub {
  const id = namespace.idFromName(sessionId);
  return locationHint ? namespace.get(id, { locationHint }) : namespace.get(id);
}

/**
 * Session runtimes as Durable Objects: each session id names one object and
 * the request travels to it over the platform's RPC.
 */
export function createDurableObjectSessionRuntimeDispatch(
  namespace: DurableObjectNamespace,
  locationHint?: DurableObjectLocationHint
): SessionRuntimeDispatch {
  return (sessionId, request) => sessionObject(namespace, sessionId, locationHint).fetch(request);
}
