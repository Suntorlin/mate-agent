/**
 * Read a public skill from a GitHub link: a SKILL.md file, or a folder holding
 * one. Only GitHub hosts are fetched, so a pasted link cannot point the control
 * plane at an internal address.
 *
 * Accepted links:
 * - https://github.com/<owner>/<repo>[/tree/<ref>/<path>] — a skill folder
 * - https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md — its folder
 * - https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>/SKILL.md — that file alone
 */

import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_REVISION_BYTES,
  type PersonalSkillFileInput,
} from "@open-inspect/shared/types/skills";
import { SkillImportError } from "./git-import";

const GITHUB_API = "https://api.github.com";
const RAW_HOST = "raw.githubusercontent.com";
const MAX_FOLDER_DEPTH = 10;
const USER_AGENT = "agent-engine-skill-import";

type Fetch = typeof fetch;

type GitHubTarget =
  | { kind: "folder"; owner: string; repo: string; ref: string | null; path: string }
  | { kind: "file"; url: string; path: string };

interface ContentsEntry {
  type: "file" | "dir" | "symlink" | "submodule";
  path: string;
  size: number;
  download_url: string | null;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Parse a pasted link into what to read, or explain why it cannot be used. */
export function parseSkillUrl(raw: string): GitHubTarget {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SkillImportError("Paste a link to a SKILL.md or a skill folder on GitHub", 400);
  }
  if (url.protocol !== "https:") {
    throw new SkillImportError("Only https links can be imported", 400);
  }
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const [owner, repo] = parts;
  const validRepo = owner && repo && SEGMENT.test(owner) && SEGMENT.test(repo);

  if (url.hostname === RAW_HOST) {
    if (!validRepo || parts.length < 4 || parts[parts.length - 1] !== "SKILL.md") {
      throw new SkillImportError("A raw GitHub link must point to a SKILL.md file", 400);
    }
    return { kind: "file", url: url.toString(), path: parts.slice(3).join("/") };
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new SkillImportError("Skills can be imported from GitHub links only", 400);
  }
  if (!validRepo) throw new SkillImportError("That GitHub link has no repository", 400);
  const name = repo.replace(/\.git$/, "");
  if (parts.length === 2) return { kind: "folder", owner, repo: name, ref: null, path: "" };
  const [, , mode, ref, ...rest] = parts;
  if ((mode !== "tree" && mode !== "blob") || !ref) {
    throw new SkillImportError("Link to a skill folder or its SKILL.md on GitHub", 400);
  }
  if (mode === "blob") {
    if (rest[rest.length - 1] !== "SKILL.md") {
      throw new SkillImportError("A GitHub file link must point to a SKILL.md", 400);
    }
    rest.pop();
  }
  return { kind: "folder", owner, repo: name, ref, path: rest.join("/") };
}

async function getJson(fetchImpl: Fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
  });
  if (response.status === 404) {
    throw new SkillImportError("Nothing public was found at that link", 404);
  }
  if (!response.ok) {
    throw new SkillImportError(`GitHub answered ${response.status}; try again later`, 502);
  }
  return response.json();
}

async function getText(fetchImpl: Fetch, url: string, path: string): Promise<string> {
  const response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
  if (response.status === 404) {
    throw new SkillImportError("Nothing public was found at that link", 404);
  }
  if (!response.ok) {
    throw new SkillImportError(`GitHub answered ${response.status}; try again later`, 502);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
    throw new SkillImportError(`${path} is over the ${MAX_SKILL_FILE_BYTES / 1024} KB limit`, 400);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new SkillImportError(`${path} is not a text file; skills hold text only`, 400);
  }
}

async function listFolder(
  fetchImpl: Fetch,
  target: Extract<GitHubTarget, { kind: "folder" }>,
  path: string,
  depth: number,
  found: ContentsEntry[]
): Promise<void> {
  if (depth > MAX_FOLDER_DEPTH) throw new SkillImportError("That folder is nested too deeply", 400);
  const encodedPath = path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const query = target.ref ? `?ref=${encodeURIComponent(target.ref)}` : "";
  const listing = await getJson(
    fetchImpl,
    `${GITHUB_API}/repos/${target.owner}/${target.repo}/contents/${encodedPath}${query}`
  );
  if (!Array.isArray(listing)) {
    throw new SkillImportError("That link is a file; link to its folder or its SKILL.md", 400);
  }
  for (const entry of listing as ContentsEntry[]) {
    if (entry.type === "dir") {
      await listFolder(fetchImpl, target, entry.path, depth + 1, found);
    } else if (entry.type === "file") {
      found.push(entry);
    }
    if (found.length > MAX_SKILL_FILES) {
      throw new SkillImportError(`A skill can hold at most ${MAX_SKILL_FILES} files`, 400);
    }
  }
}

/** Fetch a skill's files from a GitHub link, relative to the skill folder. */
export async function fetchSkillFilesFromUrl(
  raw: string,
  fetchImpl: Fetch = fetch
): Promise<PersonalSkillFileInput[]> {
  const target = parseSkillUrl(raw);
  if (target.kind === "file") {
    return [
      {
        path: "SKILL.md",
        content: await getText(fetchImpl, target.url, "SKILL.md"),
        executable: false,
      },
    ];
  }
  const entries: ContentsEntry[] = [];
  await listFolder(fetchImpl, target, target.path, 0, entries);
  const prefix = target.path ? `${target.path}/` : "";
  if (!entries.some((entry) => entry.path === `${prefix}SKILL.md`)) {
    throw new SkillImportError("That folder has no SKILL.md", 400);
  }
  const declared = entries.reduce((total, entry) => total + entry.size, 0);
  if (declared > MAX_SKILL_REVISION_BYTES) {
    throw new SkillImportError(
      `A skill can hold at most ${MAX_SKILL_REVISION_BYTES / 1024 / 1024} MB of text`,
      400
    );
  }
  const files: PersonalSkillFileInput[] = [];
  for (const entry of entries) {
    const path = entry.path.slice(prefix.length);
    if (!entry.download_url || new URL(entry.download_url).hostname !== RAW_HOST) {
      throw new SkillImportError(`${path} cannot be downloaded`, 400);
    }
    const content = await getText(fetchImpl, entry.download_url, path);
    // GitHub's contents listing carries no file mode; a script with a shebang runs.
    files.push({
      path,
      content,
      executable: path.startsWith("scripts/") && content.startsWith("#!"),
    });
  }
  return files;
}
