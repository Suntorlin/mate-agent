/**
 * The edge proxy (deploy/edge/Caddyfile) sends signed object-store requests
 * to the store and everything else to the control plane, by path. Both large
 * transfer paths sign against the same public origin (the tunnel), so every
 * key either one writes has to fall under a published prefix, and no control
 * plane route may sit under one, or the proxy would hand it to the store.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFileObjectKey, buildMediaObjectKey, buildSessionAttachmentObjectKey } from "../media";
import { routeContracts } from "../router.test-support";
import { buildWorkspaceCopyKey } from "./workspace-copies";
import { buildUserFileObjectKey } from "../files/service";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The path prefixes the edge's `@objects` matcher publishes, without the trailing `*`. */
function publishedObjectPrefixes(): string[] {
  const caddyfile = readFileSync(resolve(REPO_ROOT, "deploy/edge/Caddyfile"), "utf8");
  const matcher = caddyfile.match(/^\s*@objects\s+path\s+(.+)$/m);
  if (!matcher) throw new Error("deploy/edge/Caddyfile has no @objects path matcher");
  return matcher[1]
    .trim()
    .split(/\s+/)
    .map((pattern) => {
      if (!pattern.endsWith("/*")) throw new Error(`Unexpected object path pattern ${pattern}`);
      return pattern.slice(0, -1);
    });
}

/** OBJECT_STORE_BUCKET in .env.example: path-style URLs start with it. */
function documentedBucket(): string {
  const example = readFileSync(resolve(REPO_ROOT, "deploy/compose/.env.example"), "utf8");
  const bucket = example.match(/^OBJECT_STORE_BUCKET=(.+)$/m)?.[1]?.trim();
  if (!bucket) throw new Error(".env.example has no OBJECT_STORE_BUCKET");
  return bucket;
}

describe("edge object paths", () => {
  const prefixes = publishedObjectPrefixes();
  const bucket = documentedBucket();

  it("publishes every key prefix that clients transfer directly", () => {
    const keys = [
      // file artifacts, large videos, workspace copies (MEDIA_DIRECT).
      buildFileObjectKey("s1", "a1", "cut.mov"),
      buildMediaObjectKey("s1", "a1", "mp4"),
      buildWorkspaceCopyKey("s1", "c1", "tar.zst", Date.UTC(2026, 9, 2)),
      buildSessionAttachmentObjectKey("s1", "att1"),
      // composer and library files (MEDIA_TRANSFERS).
      buildUserFileObjectKey("u1", "f1"),
    ];
    for (const key of keys) {
      const path = `/${bucket}/${key}`;
      expect(
        prefixes.some((prefix) => path.startsWith(prefix)),
        `${path} is not published by the edge`
      ).toBe(true);
    }
  });

  it("publishes object keys only, not the bucket root", () => {
    for (const prefix of prefixes) {
      expect(prefix).toMatch(new RegExp(`^/${bucket}/[a-z-]+/$`));
    }
  });

  it("routes no control plane path to the store", () => {
    for (const route of routeContracts) {
      const first = route.path.split("/")[1] ?? "";
      expect(first.startsWith(":"), `${route.path} starts with a parameter`).toBe(false);
      expect(
        `${route.path}/`.startsWith(`/${bucket}/`),
        `${route.method} ${route.path} would be sent to the object store`
      ).toBe(false);
    }
  });
});
