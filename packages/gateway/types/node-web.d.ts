/**
 * Web-standard names the core uses as types and Node implements at runtime, but that
 * @types/node does not declare globally. Only the Node programs load this file; the workerd
 * programs take these names from workers-types.
 */

type CryptoKey = import("node:crypto").webcrypto.CryptoKey;
