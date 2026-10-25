/**
 * The Worker's bindings and the platform ports built over them: where the
 * application meets Cloudflare's binding types. A binding whose type already
 * satisfies its port passes through unwrapped, so the assignments below are
 * also the compile-time proof that it does; a workers-types upgrade or a
 * port edit that breaks one fails typecheck here rather than at the stores.
 */

import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import type { ConfigSource } from "../config-source";
import { createS3DirectTransfer } from "../storage/s3/s3-direct-transfer";
import {
  createS3LargeObjectTransfers,
  readS3TransferConfig,
} from "../storage/s3/s3-large-object-transfers";
import { readS3ObjectStorageConfig } from "../storage/s3/s3-object-storage";
import type { Env, EnvConfig, Platform } from "../types";
import { createQueueJobs, type JobQueueBindings } from "./job-queue";
import { R2ObjectStorage } from "./object-storage";
import {
  createDurableObjectSessionRuntimeDispatch,
  parseLocationHint,
} from "./session-runtime-dispatch";

/**
 * What the Worker needs to sign direct uploads: the bucket's S3 endpoint and an access key pair.
 * R2 presigns only for its S3 domain with such a pair, which the `MEDIA_BUCKET` binding cannot do.
 * All optional: without `OBJECT_STORE_ENDPOINT` the direct-transfer routes answer 501.
 */
export interface ObjectTransferBindings {
  OBJECT_STORE_BUCKET?: string;
  OBJECT_STORE_REGION?: string;
  OBJECT_STORE_ENDPOINT?: string;
  OBJECT_STORE_PUBLIC_ENDPOINT?: string;
  OBJECT_STORE_CORS_ORIGINS?: string;
  OBJECT_STORE_SANDBOX_ACCESS?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

/** Where new session Durable Objects are created, as a Cloudflare region hint (for example `enam`). */
export interface PlacementBindings {
  SESSION_DO_LOCATION_HINT?: string;
}

/** The bindings Cloudflare hands the Worker and its Durable Objects, with the deployment's configuration. */
export interface WorkerBindings
  extends EnvConfig, JobQueueBindings, ObjectTransferBindings, PlacementBindings {
  SESSION: DurableObjectNamespace;
  REPOS_CACHE: KVNamespace;
  SLACK_BOT?: Fetcher;
  LINEAR_BOT?: Fetcher;
  GATEWAY?: Fetcher;
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
}

/**
 * The direct-transfer ports over the bucket's S3 endpoint, or none when the deployment sets no
 * `OBJECT_STORE_ENDPOINT`. A half-configured endpoint (no key pair) fails loudly instead of
 * leaving uploads answering 501 for no visible reason.
 */
export function createObjectTransfers(
  variables: ConfigSource
): Pick<Platform, "MEDIA_DIRECT" | "MEDIA_TRANSFERS"> {
  if (!variables.OBJECT_STORE_ENDPOINT) return {};
  const accessKeyId = variables.AWS_ACCESS_KEY_ID;
  const secretAccessKey = variables.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "OBJECT_STORE_ENDPOINT is set but AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not: set both " +
        "secrets, or leave OBJECT_STORE_ENDPOINT empty to turn direct uploads off"
    );
  }
  const storage = {
    ...readS3ObjectStorageConfig(variables),
    credentials: { accessKeyId, secretAccessKey },
  };
  const transfer = readS3TransferConfig(variables, storage);
  return {
    MEDIA_DIRECT: createS3DirectTransfer(storage, transfer.publicEndpoint),
    MEDIA_TRANSFERS: createS3LargeObjectTransfers(storage, transfer),
  };
}

/** One set of transfer ports per bindings object, so a request does not rebuild the S3 clients. */
const objectTransfersByBindings = new WeakMap<object, ReturnType<typeof createObjectTransfers>>();

/**
 * The application environment over the Worker's bindings: every binding
 * taken off the record and put behind its port, the configuration passed
 * through as given. A binding this function does not name is refused at
 * compile time (below), so adding one is an explicit composition decision.
 */
export function createCloudflareEnv(bindings: WorkerBindings): Env {
  const {
    DB,
    SESSION,
    REPOS_CACHE,
    MEDIA_BUCKET,
    SLACK_BOT,
    LINEAR_BOT,
    GATEWAY,
    USER_MEMORY_EXTRACT_QUEUE,
    USER_MEMORY_CONSOLIDATE_QUEUE,
    OBJECT_STORE_BUCKET,
    OBJECT_STORE_REGION,
    OBJECT_STORE_ENDPOINT,
    OBJECT_STORE_PUBLIC_ENDPOINT,
    OBJECT_STORE_CORS_ORIGINS,
    OBJECT_STORE_SANDBOX_ACCESS,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    SESSION_DO_LOCATION_HINT,
    ...config
  } = bindings;
  let transfers = objectTransfersByBindings.get(bindings);
  if (!transfers) {
    transfers = createObjectTransfers({
      OBJECT_STORE_BUCKET,
      OBJECT_STORE_REGION,
      OBJECT_STORE_ENDPOINT,
      OBJECT_STORE_PUBLIC_ENDPOINT,
      OBJECT_STORE_CORS_ORIGINS,
      OBJECT_STORE_SANDBOX_ACCESS,
      AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY,
    });
    objectTransfersByBindings.set(bindings, transfers);
  }
  const platform: Platform = {
    DB,
    SESSION: createDurableObjectSessionRuntimeDispatch(
      SESSION,
      parseLocationHint(SESSION_DO_LOCATION_HINT)
    ),
    REPOS_CACHE: createKvCacheStore(REPOS_CACHE),
    MEDIA_BUCKET: new R2ObjectStorage(MEDIA_BUCKET),
    ...transfers,
    SLACK_BOT,
    LINEAR_BOT,
    GATEWAY,
    JOBS: createQueueJobs({
      USER_MEMORY_EXTRACT_QUEUE,
      USER_MEMORY_CONSOLIDATE_QUEUE,
    }),
  };
  return { ...config, ...platform };
}

// Every field of WorkerBindings is either a platform port (adapted above), a
// queue behind the jobs port, or configuration: a new binding that is none
// of these fails to compile here.
type _AssertExtends<A extends B, B> = A;
type _BindingsAreConfigOrPlatform = _AssertExtends<
  Exclude<
    keyof WorkerBindings,
    keyof Platform | keyof JobQueueBindings | keyof ObjectTransferBindings | keyof PlacementBindings
  >,
  keyof EnvConfig
>;
