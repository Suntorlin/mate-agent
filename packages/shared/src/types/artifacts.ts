import { z } from "zod";

export const artifactTypeSchema = z.enum([
  "pr",
  "screenshot",
  "video",
  "page",
  "file",
  "preview",
  "branch",
]);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

/** Artifacts stored in session media storage and served only by the protected media endpoint. */
export const MEDIA_ARTIFACT_TYPES = [
  "screenshot",
  "video",
  "page",
  "file",
] as const satisfies readonly ArtifactType[];
export type MediaArtifactType = (typeof MEDIA_ARTIFACT_TYPES)[number];

export function isMediaArtifactType(type: string): type is MediaArtifactType {
  return (MEDIA_ARTIFACT_TYPES as readonly string[]).includes(type);
}

// Artifact created by session
export const sessionArtifactSchema = z.object({
  id: z.string(),
  type: artifactTypeSchema,
  url: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
  /**
   * Last content change (epoch ms). Optional for rolling deploys — producers
   * predating PR lifecycle tracking omit it; consumers fall back to createdAt.
   */
  updatedAt: z.number().optional(),
});
export type SessionArtifact = z.infer<typeof sessionArtifactSchema>;

// ─── Pull request lifecycle ───────────────────────────────────────────────────

/** Base lifecycle of a pull request as stored (merged is terminal). */
export type PullRequestLifecycleState = "open" | "closed" | "merged";

/**
 * Stored PR state: lifecycle and draft readiness are independent facts.
 * Invariant (enforced at write boundaries): isDraft is true only while
 * lifecycleState === "open".
 */
export interface PullRequestStatus {
  lifecycleState: PullRequestLifecycleState;
  isDraft: boolean;
}

/** UI-facing status derived from PullRequestStatus. Never persisted. */
export type PullRequestDisplayStatus = "draft" | "open" | "merged" | "closed";

export function toDisplayStatus(status: PullRequestStatus): PullRequestDisplayStatus {
  if (status.lifecycleState === "merged") return "merged";
  if (status.lifecycleState === "closed") return "closed";
  return status.isDraft ? "draft" : "open";
}

/**
 * Typed metadata stored on `pr` artifacts. Mirrors the D1
 * session_pull_requests record's provider-derived fields; the DO artifact is a
 * live view of that record. Spread-compatible with the untyped
 * Record<string, unknown> metadata boundary.
 */
export interface PullRequestArtifactMetadata {
  number: number;
  lifecycleState: PullRequestLifecycleState;
  isDraft: boolean;
  /** Head (source) branch name. */
  head: string;
  /** Base (target) branch name. */
  base: string;
  headSha?: string;
  repoOwner: string;
  repoName: string;
  /** Stable provider repo id (canonical identity); absent on legacy rows. */
  repositoryExternalId?: string;
  /** Provider's updated_at (epoch ms) — the monotonic write guard source. */
  providerUpdatedAt?: number;
  // No `provider` field: provider is deployment state (ADR-0001).
}

/**
 * Metadata stored on branch artifacts when PR creation falls back to manual flow.
 */
export interface ManualPullRequestArtifactMetadata {
  mode: "manual_pr";
  head: string;
  base: string;
  createPrUrl: string;
  provider?: string;
}

/** Metadata stored on screenshot artifacts. */
export interface ScreenshotArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** MIME type: image/png, image/jpeg, image/webp */
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** File size in bytes */
  sizeBytes: number;
  /** Viewport dimensions at capture time */
  viewport?: { width: number; height: number };
  /** URL that was screenshotted */
  sourceUrl?: string;
  /** Whether this is a full-page screenshot */
  fullPage?: boolean;
  /** Whether element annotations are overlaid */
  annotated?: boolean;
  /** Caption or description provided by the agent */
  caption?: string;
}

/** Metadata stored on video recording artifacts. */
export interface VideoArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** MIME type for saved recordings. */
  mimeType: "video/mp4";
  /** File size in bytes */
  sizeBytes: number;
  /** Agent-provided title or description of the validation recording */
  caption: string;
  /** Recording duration in milliseconds */
  durationMs: number;
  /** Artifact creation time as epoch milliseconds */
  createdAt: number;
  /** Recording start time as epoch milliseconds */
  recordingStartedAt: number;
  /** Recording end time as epoch milliseconds */
  recordingEndedAt: number;
  /** Captured viewport dimensions */
  dimensions: { width: number; height: number };
  /** Whether recording stopped at the maximum duration */
  truncated: boolean;
  /** Whether the video has an audio track; browser recordings never do, rendered videos may. */
  hasAudio?: boolean;
  /** Captured surface for v1 */
  captureSurface?: "browser";
  /** Artifact source */
  source?: "agent";
  /** URL at recording start */
  sourceUrl?: string;
  /** URL when recording stopped */
  endUrl?: string;
}

/** Metadata stored on page artifacts: a self-contained HTML page the agent made for the user. */
export interface PageArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** Pages are always served as UTF-8 HTML. */
  mimeType: "text/html";
  /** File size in bytes */
  sizeBytes: number;
  /** Title shown for the page */
  caption?: string;
}

/**
 * What a file artifact is: a deliverable the agent hands over (`file`) or a bundle of the whole
 * project folder (`project`), which the preview pane offers as "Download project".
 */
export type FileArtifactKind = "file" | "project";

/**
 * Metadata stored on file artifacts: any file the agent hands over for download (documents,
 * archives, editing-app project files, masters in any codec). File artifacts are uploaded straight
 * to the object store and are always served as attachments, never rendered in the app.
 */
export interface FileArtifactMetadata {
  /** Object store key */
  objectKey: string;
  /** The name the file downloads under. */
  filename: string;
  /** Declared content type; only ever used as a hint, the file is always served as an attachment. */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Title shown for the file */
  caption?: string;
  /** Defaults to "file". */
  kind?: FileArtifactKind;
}

// Pull request info
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed" | "merged" | "draft";
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The `/artifacts` list response is the session artifact shape verbatim — the
 * producer serializes stored artifact rows, `updatedAt` included. It reuses
 * `sessionArtifactSchema` rather than restating the fields so the two can never
 * drift (a restated copy silently stripped `updatedAt`).
 */
export const listArtifactsResponseSchema = z.object({
  artifacts: z.array(sessionArtifactSchema),
});

export type ArtifactResponse = z.infer<typeof sessionArtifactSchema>;
export type ListArtifactsResponse = z.infer<typeof listArtifactsResponseSchema>;

export interface ToolCallSummary {
  tool: string;
  summary: string;
}

export interface ArtifactInfo {
  type: ArtifactType;
  url: string;
  label: string;
  metadata?: Record<string, unknown> | null;
}

/** Message-scoped media that can be fetched from the protected media endpoint. */
export interface MediaArtifactInfo {
  id: string;
  type: "screenshot" | "video";
  mimeType?: string;
  sizeBytes?: number;
  caption?: string;
}

export interface AgentResponse {
  textContent: string;
  toolCalls: ToolCallSummary[];
  artifacts: ArtifactInfo[];
  mediaArtifacts: MediaArtifactInfo[];
  success: boolean;
  error?: string;
}
