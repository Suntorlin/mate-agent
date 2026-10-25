/**
 * Managed Vercel base-runtime snapshot builder.
 *
 * This creates a temporary Vercel Sandbox, applies the shared runtime
 * bootstrap, snapshots the resulting filesystem, and stops the temporary
 * session. Terraform normally gives the temporary sandbox a deterministic
 * name and the control plane resolves that name to the latest snapshot ID.
 */

import { createLogger } from "../../control-plane/src/logger";
import type { CorrelationContext } from "../../control-plane/src/logger";
import {
  VERCEL_LOCAL_RUNTIME_EXTRACT_DIR,
  VERCEL_RUNTIME_WORKDIR,
  buildVercelBootstrapScript,
} from "./bootstrap";
import {
  DEFAULT_VERCEL_IMAGE,
  VERCEL_PYTHON_BIN,
} from "../../control-plane/src/sandbox/providers/vercel/bootstrap";
import type { VercelSandboxClient } from "../../control-plane/src/sandbox/providers/vercel/client";

const log = createLogger("vercel-base-snapshot");

const DEFAULT_BASE_SNAPSHOT_NAME_PREFIX = "openinspect-base";
/**
 * How long the bootstrap may run. 20 min is plenty on a healthy Ubuntu mirror (a build takes about
 * 6); a slow mirror can stretch the apt phase alone past that, so VERCEL_BOOTSTRAP_TIMEOUT_MS can
 * raise it for a build. The build sandbox lives 10 min longer, for the snapshot step.
 */
const BOOTSTRAP_TIMEOUT_MS = Number(process.env.VERCEL_BOOTSTRAP_TIMEOUT_MS) || 20 * 60 * 1000;
const DEFAULT_BASE_SNAPSHOT_TIMEOUT_MS = BOOTSTRAP_TIMEOUT_MS + 10 * 60 * 1000;
const PREPARE_RUNTIME_UPLOAD_TIMEOUT_MS = 30_000;
const BOOTSTRAP_POLL_INTERVAL_MS = 15_000;
const BOOTSTRAP_POLL_TIMEOUT_MS = 30_000;
const BOOTSTRAP_EXIT_FILE = `${VERCEL_RUNTIME_WORKDIR}/bootstrap.exit`;
const BOOTSTRAP_LOG_FILE = `${VERCEL_RUNTIME_WORKDIR}/bootstrap.log`;
/** Exit code of the poll command while the bootstrap is still running. */
const STILL_RUNNING = 255;

export interface BuildVercelBaseSnapshotConfig {
  /** Managed image to build on; defaults to DEFAULT_VERCEL_IMAGE. */
  image?: string;
  /** How often to check whether the detached bootstrap finished; defaults to 15 s. */
  bootstrapPollIntervalMs?: number;
  runtimeArchive: Uint8Array;
  runtimeExtractDir?: string;
  sourceVersion?: string;
  sandboxName?: string;
  namePrefix?: string;
  now?: number;
  correlation?: CorrelationContext;
}

export interface BuildVercelBaseSnapshotResult {
  snapshotId: string;
  sandboxName: string;
  sessionId: string;
}

export async function buildVercelBaseSnapshot(
  client: VercelSandboxClient,
  config: BuildVercelBaseSnapshotConfig
): Promise<BuildVercelBaseSnapshotResult> {
  const runtimeExtractDir = config.runtimeExtractDir || VERCEL_LOCAL_RUNTIME_EXTRACT_DIR;
  const runtimeSourceRef = config.sourceVersion || "local-checkout";
  const sandboxName =
    config.sandboxName ||
    buildBaseSnapshotSandboxName({
      prefix: config.namePrefix || DEFAULT_BASE_SNAPSHOT_NAME_PREFIX,
      sourceVersion: config.sourceVersion,
      now: config.now ?? Date.now(),
    });

  const created = await client.createSandbox(
    {
      name: sandboxName,
      image: config.image || DEFAULT_VERCEL_IMAGE,
      timeoutMs: DEFAULT_BASE_SNAPSHOT_TIMEOUT_MS,
      ports: [],
      tags: {
        openinspect_framework: "open-inspect",
        openinspect_kind: "base-runtime-build",
        openinspect_runtime_source: "local-checkout",
        openinspect_runtime_ref: runtimeSourceRef,
        ...(config.sourceVersion ? { openinspect_source_version: config.sourceVersion } : {}),
      },
    },
    config.correlation
  );

  const sessionId = created.session.id;
  try {
    const prepareResult = await client.runCommandAndWait(
      {
        sessionId,
        command: "bash",
        args: [
          "-lc",
          `rm -rf ${shellQuote(VERCEL_RUNTIME_WORKDIR)} && mkdir -p ${shellQuote(runtimeExtractDir)}`,
        ],
        timeoutMs: PREPARE_RUNTIME_UPLOAD_TIMEOUT_MS,
      },
      config.correlation
    );
    if (prepareResult.exitCode !== 0) {
      throw new Error(
        `Vercel base runtime upload directory preparation failed with exit code ${prepareResult.exitCode}`
      );
    }

    await client.writeFileArchive(
      {
        sessionId,
        archive: config.runtimeArchive,
        extractDir: runtimeExtractDir,
      },
      config.correlation
    );

    const exitCode = await runDetachedAndPoll(
      client,
      sessionId,
      buildVercelBootstrapScript({ runtimeExtractDir }),
      config.bootstrapPollIntervalMs ?? BOOTSTRAP_POLL_INTERVAL_MS,
      config.correlation
    );
    if (exitCode !== 0) {
      throw new Error(`Vercel base runtime bootstrap failed with exit code ${exitCode}`);
    }

    const snapshot = await client.snapshotSession(
      sessionId,
      { expirationMs: 0 },
      config.correlation
    );

    if (snapshot.snapshot.status !== "created") {
      throw new Error(`Vercel base snapshot status was ${snapshot.snapshot.status}`);
    }

    await verifyVercelSnapshot(client, snapshot.snapshot.id, sandboxName);

    log.info("vercel_base_snapshot.created", {
      snapshot_id: snapshot.snapshot.id,
      sandbox_name: sandboxName,
      session_id: sessionId,
      runtime_source: "local-checkout",
      runtime_source_ref: runtimeSourceRef,
    });

    return {
      snapshotId: snapshot.snapshot.id,
      sandboxName,
      sessionId,
    };
  } finally {
    try {
      await client.stopSession(sessionId, config.correlation);
    } catch (error) {
      log.warn("vercel_base_snapshot.stop_failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Vercel closes a waiting command request after about five minutes, and the media phase
 * (models, Python libraries) makes the bootstrap longer than that, so it runs detached and its exit
 * code is polled from a file. Returns the bootstrap's exit code.
 */
async function runDetachedAndPoll(
  client: VercelSandboxClient,
  sessionId: string,
  script: string,
  pollIntervalMs: number,
  correlation?: CorrelationContext
): Promise<number> {
  await client.startCommand(
    {
      sessionId,
      command: "bash",
      args: [
        "-lc",
        `(${script}) > ${shellQuote(BOOTSTRAP_LOG_FILE)} 2>&1; echo $? > ${shellQuote(BOOTSTRAP_EXIT_FILE)}`,
      ],
      timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    },
    correlation
  );
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
  const exitFile = shellQuote(BOOTSTRAP_EXIT_FILE);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const poll = await client.runCommandAndWait(
      {
        sessionId,
        command: "bash",
        args: ["-c", `test -s ${exitFile} || exit ${STILL_RUNNING}; exit "$(cat ${exitFile})"`],
        timeoutMs: BOOTSTRAP_POLL_TIMEOUT_MS,
      },
      correlation
    );
    if (poll.exitCode !== STILL_RUNNING) return poll.exitCode ?? -1;
  }
  throw new Error(`Vercel base runtime bootstrap did not finish within ${BOOTSTRAP_TIMEOUT_MS} ms`);
}

export function buildBaseSnapshotSandboxName(params: {
  prefix: string;
  sourceVersion?: string;
  now: number;
}): string {
  const source = params.sourceVersion ? params.sourceVersion.slice(0, 12) : "manual";
  const raw = `${params.prefix}-${source}-${params.now}`;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.slice(0, 96) || `${DEFAULT_BASE_SNAPSHOT_NAME_PREFIX}-${params.now}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function verifyVercelSnapshot(
  client: VercelSandboxClient,
  snapshotId: string,
  name = "openinspect-verify"
): Promise<void> {
  const restored = await client.createSandbox(
    {
      name: `${name}-verify`,
      sourceSnapshotId: snapshotId,
      timeoutMs: 5 * 60 * 1000,
      ports: [],
    },
    undefined
  );
  try {
    const verified = await client.runCommandAndWait(
      {
        sessionId: restored.session.id,
        command: "bash",
        args: ["-lc", `${VERCEL_PYTHON_BIN} /app/verify/smoke_test.py verify`],
        sudo: true,
        timeoutMs: 240_000,
      },
      undefined
    );
    if (verified.exitCode !== 0) throw new Error("Vercel fresh-artifact verification failed");
  } finally {
    await client.stopSession(restored.session.id, undefined);
  }
}
