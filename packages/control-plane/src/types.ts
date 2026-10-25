/**
 * Type definitions for Open-Inspect Control Plane.
 */

import type { CacheStore } from "@open-inspect/shared/cache-store";
import type { SqlDatabase } from "./db/sql-database";
import type { Jobs } from "./jobs";
import type { FetchClient } from "./platform-ports";
import type { SessionRuntimeDispatch } from "./session/runtime-client";
import type { LargeObjectTransfers } from "./storage/large-object-transfers";
import type { ObjectStorage } from "./storage/object-storage";
import type { DirectObjectTransfer } from "./storage/direct-transfer";

/**
 * The deployment's configuration: variables and secrets, every one a string,
 * so any host can supply them.
 */
export interface EnvConfig {
  // Secrets
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  BROWSER_AUTH_SECRET?: string;
  TOKEN_ENCRYPTION_KEY: string;
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY: string;
  REPO_SECRETS_ENCRYPTION_KEY?: string;
  MODAL_TOKEN_ID?: string;
  MODAL_TOKEN_SECRET?: string;
  MODAL_API_SECRET?: string; // Shared secret for authenticating with Modal endpoints
  ANTHROPIC_API_KEY?: string; // Anthropic API key for Claude models
  DAYTONA_API_KEY?: string; // Daytona REST API key (Bearer auth + HMAC derivation)
  OPENCOMPUTER_API_KEY?: string; // OpenComputer REST API key (X-API-Key auth + HMAC derivation)
  VERCEL_TOKEN?: string; // Vercel API access token for Sandbox API
  // Pepper for image-build callback token hashes.
  IMAGE_CALLBACK_TOKEN_PEPPER?: string;
  // Per-service sig1 verification keys. Absent ⇒ that service cannot
  // authenticate.
  SERVICE_AUTH_SECRET_WEB?: string;
  SERVICE_AUTH_SECRET_SLACK_BOT?: string;
  SERVICE_AUTH_SECRET_GITHUB_BOT?: string;
  SERVICE_AUTH_SECRET_LINEAR_BOT?: string;
  SERVICE_AUTH_SECRET_APP?: string; // A product backend on the engine (relays `app:<id>` users)
  SLACK_BOT_TOKEN?: string; // Slack bot token for agent-initiated chat.postMessage calls

  // GitHub App secrets (for git operations)
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;

  // GitLab secrets (for git operations and API access when SCM_PROVIDER=gitlab)
  GITLAB_ACCESS_TOKEN?: string;
  GITLAB_NAMESPACE?: string; // Group namespace to scope repository listing

  // Variables
  DEPLOYMENT_NAME: string;
  APP_NAME?: string; // Display name for user-visible UI, PR footers, and HTTP User-Agent headers
  GITHUB_BOT_USERNAME: string; // GitHub App bot login used for self-origin checks
  SCM_PROVIDER?: string; // Source control provider for this deployment (default: github)
  WORKER_URL?: string; // Base URL for the worker (for callbacks)
  WEB_APP_URL?: string; // Base URL for the web app (for PR links)
  ALLOWED_USERS?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  ALLOWED_EMAILS?: string;
  ALLOWED_GITHUB_ORGS?: string;
  UNSAFE_ALLOW_ALL_USERS?: string;
  CF_ACCOUNT_ID?: string; // Cloudflare account ID
  SANDBOX_PROVIDER?: string; // "modal" (default), "daytona", "vercel", "opencomputer", or "e2b"
  MODAL_WORKSPACE?: string; // Modal workspace name
  MODAL_ENVIRONMENT?: string; // Modal environment name for dashboard URLs
  MODAL_ENVIRONMENT_WEB_SUFFIX?: string; // Modal environment web suffix for endpoint URLs
  // Origin serving the Modal functions by path, in place of their derived
  // `*.modal.run` hosts. Unset in every cloud deployment; a proxy or a
  // stand-in server sets it, as the other providers' `*_API_URL` settings do.
  MODAL_API_URL?: string;
  DAYTONA_API_URL?: string; // Daytona REST API base URL
  DAYTONA_BASE_SNAPSHOT?: string; // Named Daytona snapshot used for fresh sandbox creation
  DAYTONA_AUTO_STOP_INTERVAL_MINUTES?: string; // Daytona idle stop interval in minutes
  DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES?: string; // Daytona archive interval in minutes
  DAYTONA_TARGET?: string; // Optional Daytona target name
  DAYTONA_TOOLBOX_API_URL?: string; // Optional explicit Daytona toolbox proxy base URL
  DAYTONA_PREBUILDS_ENABLED?: string; // Admits new Daytona image builds and prebuilt selection
  OPENCOMPUTER_API_URL?: string; // OpenComputer REST API base URL
  OPENCOMPUTER_TEMPLATE?: string; // Declarative template containing sandbox runtime
  VERCEL_PROJECT_ID?: string; // Vercel project ID used for Sandbox API scope
  VERCEL_TEAM_ID?: string; // Optional Vercel team ID used for Sandbox API scope
  VERCEL_BASE_SNAPSHOT_ID?: string; // Optional prebuilt base snapshot with sandbox runtime
  VERCEL_BASE_SNAPSHOT_NAME?: string; // Optional managed base snapshot sandbox name
  VERCEL_IMAGE?: string; // Vercel managed image (default: vercel/sandbox/node:24)
  VERCEL_DEFAULT_VCPUS?: string; // vCPUs (1, 2, 4 or 8) when session settings request none; default: Vercel's 2
  VERCEL_RUNTIME?: string; // Deprecated and ignored; Vercel sandboxes start from VERCEL_IMAGE
  VERCEL_SANDBOX_API_BASE_URL?: string; // Override for tests or non-default Vercel API base URL
  VERCEL_SNAPSHOT_EXPIRATION_MS?: string; // Snapshot expiration in ms; 0 means no expiration
  VERCEL_MAX_SESSION_TIMEOUT_MS?: string; // Plan's max session duration in ms; defaults to the Hobby ceiling

  E2B_API_KEY?: string; // E2B REST API key (X-API-Key header + HMAC derivation)
  E2B_API_URL?: string; // E2B REST API base URL (default https://api.e2b.app)
  E2B_TEMPLATE_ID?: string; // Pre-built E2B template ID
  E2B_SANDBOX_TIMEOUT_SECONDS?: string; // Sandbox TTL in seconds; Hobby plans must set 3300
  E2B_AUTO_PAUSE?: string; // "true" (default) pauses on TTL expiry (resumable, auto-resumes) instead of killing

  // Sandbox lifecycle configuration
  SANDBOX_INACTIVITY_TIMEOUT_MS?: string; // Inactivity timeout in ms (default: 600000 = 10 min)
  SANDBOX_LIFETIME_EXTENSION_MS?: string; // Step by which a sandbox in use is kept alive past its lifetime, up to the provider's ceiling; 0 disables (default: DEFAULT_SANDBOX_LIFETIME_EXTENSION_MS)
  SANDBOX_BOOT_TIMEOUT_MS?: string; // Longest a connected sandbox may boot before it is failed, in ms; defaults to DEFAULT_BOOT_BUDGET_CONFIG
  EXECUTION_TIMEOUT_MS?: string; // Max processing time for one message before auto-fail, for sessions and for the automation runs watching them; overridden per session by sandboxTimeoutMs, and falls back to DEFAULT_SANDBOX_TIMEOUT_SECONDS
  SECRETS_CAP_ENFORCEMENT?: string; // "enforce" (default) fails spawn/build on oversized secret payloads; set "warn" to only log
  TEAMS_ENFORCEMENT?: string; // "off" | "shadow" (default) | "on"
  DEFAULT_SESSION_VISIBILITY?: string; // "workspace" | "private"; unset means workspace
  DEFAULT_SESSION_HARNESS?: string; // Harness for a new session whose create request names none; unset means DEFAULT_HARNESS

  // Logging
  LOG_LEVEL?: string; // "debug" | "info" | "warn" | "error" (default: "info")

  // The LLM gateway (see src/gateway/config.ts); both or neither
  GATEWAY_URL?: string; // Gateway base URL handed to sandboxes
  GATEWAY_SECRET?: string; // HS256 key for the per-session gateway token
  JEV_API_KEY?: string; // OpenRouter key for Jev, which picks the effort of prompts that ask for "auto"
  INLINE_LLM_BASE_URL?: string; // Messages API base for the inline runtime (e.g. https://openrouter.ai/api); unset turns it off
  INLINE_LLM_API_KEY?: string; // Key for INLINE_LLM_BASE_URL
  INLINE_MODEL?: string; // Model the inline runtime runs (e.g. anthropic/claude-sonnet-4.6)
  MEMORY_MODEL?: string; // Model the memory jobs run on INLINE_LLM_BASE_URL when there is no gateway (default DEFAULT_DIRECT_MEMORY_MODEL)
  APP_MCP_URL?: string; // The product's MCP server (its tools), for `app:<id>` users
  APP_TOKEN_URL?: string; // Where the engine asks the product for a user's MCP token
  APP_ENGINE_TOKEN?: string; // The engine's bearer at APP_TOKEN_URL
  APP_MCP_NAME?: string; // The name the agent knows the product's MCP server by (its tools are mcp__<name>__<tool>); default "app"
  USER_FILES_QUOTA_GB?: string; // Bytes (in GiB) one user may keep in uploads and their library; defaults to DEFAULT_USER_FILES_QUOTA_BYTES
}

/**
 * The deployment-wide ports the host supplies. Each field keeps the name of
 * the Worker binding it stands in for, so services read the same `env` on
 * every host; the host's composition root builds the record
 * (`cloudflare/platform.ts` on Workers).
 */
export interface Platform {
  /** The global store. Request paths take it injected and instrumented (`ctx.db`), never from here. */
  DB: SqlDatabase;
  /** Delivery to session runtimes, addressed by session id. */
  SESSION: SessionRuntimeDispatch;
  /** Short-lived cache for the /repos listing. */
  REPOS_CACHE: CacheStore;
  /** Media artifacts: screenshots, uploads, session media. */
  MEDIA_BUCKET: ObjectStorage;
  /**
   * Signed transfers straight between clients and the media store (file artifacts, large videos,
   * workspace copies); absent where the host cannot sign them or clients cannot reach the store.
   */
  MEDIA_DIRECT?: DirectObjectTransfer;
  /** Client-side transfers of large media objects; absent where the store cannot presign. */
  MEDIA_TRANSFERS?: LargeObjectTransfers;
  /** The slack-bot service, when deployed. */
  SLACK_BOT?: FetchClient;
  /** The linear-bot service, when deployed. */
  LINEAR_BOT?: FetchClient;
  /**
   * The LLM gateway, where it runs as a Worker of the same account. The engine's own calls
   * (usage, admin, memory) go through it: a Worker cannot fetch another Worker by its public
   * address (Cloudflare answers 404, error 1042). Sandboxes still reach the gateway at
   * `GATEWAY_URL`.
   */
  GATEWAY?: FetchClient;
  /** Durable background work supplied by every host. */
  JOBS: Jobs;
}

/** What the application runs against: its configuration and the platform ports. */
export interface Env extends EnvConfig, Platform {}

/** Authenticated client state stored in session-runtime memory. */
export interface ClientInfo {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
  clientId: string;
  /** Wall-clock time when this connection's authorization lease expires. */
  authorizationExpiresAt: number;
  /** A product user's connection: authorized only on sessions that user started. */
  ownSessionsOnly?: boolean;
  lastFetchHistoryAtMs?: number;
}
