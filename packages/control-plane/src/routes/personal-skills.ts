/**
 * The signed-in user's skill library (the product's Skills page).
 *
 * - `GET /my-skills` — built-in, shared and own skills, with on/off state
 * - `GET /my-skills/:key` — one skill with its full SKILL.md
 * - `PATCH /my-skills/:key` — switch a skill on or off for the caller's new
 *   sessions, or set the drawn cover or the example output (an image or video
 *   of their sessions or their file library) of one of the caller's own skills
 * - `DELETE /my-skills/:key` — delete one of the caller's own skills
 * - `POST /my-skills` — save an uploaded SKILL.md or zip as the caller's skill
 * - `POST /my-skills/import-url` — import a public skill from a GitHub link
 * - `POST /sessions/:id/saved-skills` — the sandbox saves what a session did
 *   as its owner's skill (`save-skill`)
 *
 * Own skills are private: every query is keyed by the caller (or the session
 * owner), never by an id alone. Keys are `builtin:<name>` for skills baked into
 * the sandbox image and skill ids otherwise.
 */

import { Hono } from "hono";
import {
  importPersonalSkillUrlInputSchema,
  sandboxSavePersonalSkillInputSchema,
  savePersonalSkillInputSchema,
  updateMySkillInputSchema,
  type MySkill,
  type MySkillDetail,
  type PersonalSkillFileInput,
  type SkillCover,
  type SkillCoverChoice,
} from "@open-inspect/shared/types/skills";
import {
  PersonalSkillStore,
  UserSkillPreferenceStore,
  type PersonalSkill,
} from "../db/personal-skills";
import { SessionIndexStore } from "../db/session-index";
import { UserFileStore } from "../files/store";
import { SkillConflictError, SkillStore } from "../db/skills";
import type { SqlDatabase } from "../db/sql-database";
import { LISTED_BUILTIN_SKILLS, builtinSkillByKey } from "../skills/builtin-skills";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SkillRevisionValidationError } from "../skills/content-addressing";
import { SkillImportError } from "../skills/git-import";
import { parseSkillUpload } from "../skills/personal-upload";
import { fetchSkillFilesFromUrl } from "../skills/url-import";
import type { Env } from "../types";
import { parseBody } from "./body";
import { getSessionArtifactFromRuntime } from "./session-media-artifacts";
import { withSessionRuntime } from "./session-route";
import {
  actingUserId,
  appUserSelf,
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
  type UserOrServiceRouteContext,
} from "./shared";

const log = createLogger("router:personal-skills");

function ownToMySkill(skill: PersonalSkill): MySkill {
  return {
    key: skill.id,
    kind: "own",
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    locales: skill.locales,
    enabled: skill.enabled,
    toggleable: true,
    cover: skill.cover,
    art: skill.art,
    updatedAt: skill.updatedAt,
  };
}

async function listMySkills(db: SqlDatabase, userId: string): Promise<MySkill[]> {
  const [own, shared, disabled] = await Promise.all([
    new PersonalSkillStore(db).list(userId),
    new SkillStore(db).listForEveryone(),
    new UserSkillPreferenceStore(db).disabledKeys(userId),
  ]);
  return [
    ...own.map(ownToMySkill),
    ...LISTED_BUILTIN_SKILLS.map<MySkill>((skill) => ({
      key: skill.key,
      kind: "builtin",
      name: skill.name,
      displayName: null,
      description: skill.tagline,
      locales: {},
      enabled: !skill.toggleable || !disabled.has(skill.key),
      toggleable: skill.toggleable,
      cover: null,
      art: null,
      updatedAt: null,
    })),
    ...shared.map<MySkill>((skill) => ({
      key: skill.id,
      kind: "shared",
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      locales: skill.locales,
      enabled: !disabled.has(skill.id),
      toggleable: true,
      cover: null,
      art: skill.art,
      updatedAt: skill.updatedAt,
    })),
  ];
}

async function handleList(
  _request: Request,
  env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  return json({ skills: await listMySkills(ctx.db, actingUserId(ctx)) });
}

async function handleGet(
  _request: Request,
  _env: Env,
  params: { key: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const userId = actingUserId(ctx);
  const summary = (await listMySkills(ctx.db, userId)).find((skill) => skill.key === params.key);
  if (!summary) return error("Skill not found", 404);
  let detail: MySkillDetail | null = null;
  if (summary.kind === "builtin") {
    const builtin = builtinSkillByKey(summary.key)!;
    detail = { ...summary, markdown: builtin.markdown, files: builtin.files };
  } else {
    const files =
      summary.kind === "own"
        ? (await new PersonalSkillStore(ctx.db).get(summary.key, userId))?.files
        : (await new SkillStore(ctx.db).get(summary.key))?.files;
    if (!files) return error("Skill not found", 404);
    detail = {
      ...summary,
      markdown: files.find((file) => file.path === "SKILL.md")?.content ?? "",
      files: files
        .filter((file) => file.path !== "SKILL.md")
        .map((file) => ({ path: file.path, sizeBytes: file.sizeBytes })),
    };
  }
  return json({ skill: detail });
}

async function handleUpdate(
  request: Request,
  env: Env,
  params: { key: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, updateMySkillInputSchema, "Invalid skill update");
  if (parsed instanceof Response) return parsed;
  const userId = actingUserId(ctx);
  const summary = (await listMySkills(ctx.db, userId)).find((skill) => skill.key === params.key);
  if (!summary) return error("Skill not found", 404);
  if ("art" in parsed) {
    if (summary.kind !== "own") return error("Only your own skills can change their cover", 403);
    await new PersonalSkillStore(ctx.db).setArt(summary.key, userId, parsed.art);
    return json({ skill: { ...summary, art: parsed.art } });
  }
  if ("cover" in parsed) {
    if (summary.kind !== "own") return error("Only your own skills can change their cover", 403);
    const cover = parsed.cover && (await resolveCover(env, ctx, userId, parsed.cover));
    if (cover instanceof Response) return cover;
    await new PersonalSkillStore(ctx.db).setCover(summary.key, userId, cover);
    return json({ skill: { ...summary, cover } });
  }
  if (!summary.toggleable) return error("This skill is always on", 409);
  if (summary.kind === "own") {
    await new PersonalSkillStore(ctx.db).setEnabled(summary.key, userId, parsed.enabled);
  } else {
    await new UserSkillPreferenceStore(ctx.db).set(userId, summary.key, parsed.enabled);
  }
  return json({ skill: { ...summary, enabled: parsed.enabled } });
}

/**
 * The stored form of a cover the owner picked: an image or video of one of
 * their own sessions, or a ready image or video in their file library.
 * Anything else, or anything of someone else's, is not found.
 */
async function resolveCover(
  env: Env,
  ctx: UserOrServiceRouteContext,
  userId: string,
  choice: SkillCoverChoice
): Promise<SkillCover | Response> {
  if ("fileId" in choice) {
    const file = await new UserFileStore(ctx.db).getOwned(choice.fileId, userId);
    if (!file || file.status !== "ready") return error("File not found", 404);
    if (file.kind !== "image" && file.kind !== "video") {
      return error("A cover must be an image or a video", 400);
    }
    return { fileId: file.id, kind: file.kind };
  }
  const session = await new SessionIndexStore(ctx.db).get(choice.sessionId);
  if (!session || session.userId !== userId) return error("Session not found", 404);
  const artifact = await getSessionArtifactFromRuntime(
    choice.sessionId,
    choice.artifactId,
    withSessionRuntime(env, ctx)
  );
  if (artifact instanceof Response) return artifact;
  if (!artifact || !artifact.url) return error("Media artifact not found", 404);
  if (artifact.type !== "screenshot" && artifact.type !== "video") {
    return error("A cover must be an image or a video", 400);
  }
  return {
    sessionId: choice.sessionId,
    artifactId: artifact.id,
    kind: artifact.type === "video" ? "video" : "image",
  };
}

async function handleDelete(
  _request: Request,
  _env: Env,
  params: { key: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const deleted = await new PersonalSkillStore(ctx.db).delete(params.key, actingUserId(ctx));
  if (!deleted) return error("Skill not found", 404);
  log.info("personal_skills.deleted", { user_id: actingUserId(ctx), skill_id: params.key });
  return json({ ok: true });
}

/** Validate an uploaded directory and store it as the owner's skill. */
async function saveUpload(
  db: SqlDatabase,
  ownerUserId: string,
  files: PersonalSkillFileInput[],
  options: { replace: boolean; cover?: SkillCover | null }
): Promise<Response> {
  try {
    const upload = parseSkillUpload(files);
    const store = new PersonalSkillStore(db);
    if (await store.sharedNameTaken(upload.name)) {
      return error(`${upload.name} is already a shared skill; choose another name`, 409);
    }
    const saved = await store.save(ownerUserId, upload.name, upload.content, options);
    log.info("personal_skills.saved", {
      user_id: ownerUserId,
      skill_id: saved.skill.id,
      created: saved.created,
      revision_number: saved.skill.revisionNumber,
    });
    return json(
      { skill: ownToMySkill(saved.skill), created: saved.created },
      saved.created ? 201 : 200
    );
  } catch (e) {
    if (e instanceof SkillImportError) return error(e.message, e.status);
    if (e instanceof SkillConflictError) return error(e.message, 409);
    if (e instanceof SkillRevisionValidationError) return error(e.message, 400);
    throw e;
  }
}

async function handleSave(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, savePersonalSkillInputSchema, "Invalid skill");
  if (parsed instanceof Response) return parsed;
  return saveUpload(ctx.db, actingUserId(ctx), parsed.files, { replace: parsed.replace });
}

async function handleImportUrl(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, importPersonalSkillUrlInputSchema, "Invalid link");
  if (parsed instanceof Response) return parsed;
  let files: PersonalSkillFileInput[];
  try {
    files = await fetchSkillFilesFromUrl(parsed.url);
  } catch (e) {
    if (e instanceof SkillImportError) return error(e.message, e.status);
    log.warn("personal_skills.url_fetch_failed", {
      user_id: actingUserId(ctx),
      error: e instanceof Error ? e.message : String(e),
    });
    return error("That link could not be read; try again later", 502);
  }
  return saveUpload(ctx.db, actingUserId(ctx), files, { replace: parsed.replace });
}

async function handleSandboxSave(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, sandboxSavePersonalSkillInputSchema, "Invalid skill");
  if (parsed instanceof Response) return parsed;
  const owner = (await new SessionIndexStore(ctx.db).get(params.id))?.userId ?? null;
  if (!owner) return error("This session has no owner to save a skill for", 404);
  const cover: SkillCover | undefined = parsed.coverArtifactId
    ? {
        sessionId: params.id,
        artifactId: parsed.coverArtifactId,
        kind: parsed.coverKind ?? "video",
      }
    : undefined;
  // Saving again from a session is how a skill gets its latest version.
  return saveUpload(ctx.db, owner, parsed.files, { replace: true, cover });
}

export const personalSkillRoutes = new Hono<ControlPlaneHonoEnv>();

const READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: appUserSelf(),
  cacheControl: "private, no-store",
});
const WRITE = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: appUserSelf({ auditAllowed: true }),
});

personalSkillRoutes.get("/my-skills", READ, (c) => dispatch(c, handleList));
personalSkillRoutes.post("/my-skills", WRITE, (c) => dispatch(c, handleSave));
personalSkillRoutes.post("/my-skills/import-url", WRITE, (c) => dispatch(c, handleImportUrl));
personalSkillRoutes.get("/my-skills/:key", READ, (c) => dispatch(c, handleGet));
personalSkillRoutes.patch("/my-skills/:key", WRITE, (c) => dispatch(c, handleUpdate));
personalSkillRoutes.delete("/my-skills/:key", WRITE, (c) => dispatch(c, handleDelete));
personalSkillRoutes.post(
  "/sessions/:id/saved-skills",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    cacheControl: "no-store",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleSandboxSave)
);
