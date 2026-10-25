export interface SessionTitleUpdateOptions {
  onlyIfUnset?: boolean;
  /**
   * With `onlyIfUnset`: also replace a title that is still a prompt's first
   * line (the fallback), which nobody chose.
   */
  replaceFallback?: boolean;
}

type SessionTitleUpdateErrorReason = "invalid" | "not_found" | "already_set";

export type SessionTitleValidationResult =
  | { ok: true; title: string }
  | { ok: false; reason: "invalid"; error: string };

export type SessionTitleUpdateResult =
  | { ok: true; title: string }
  | { ok: false; reason: SessionTitleUpdateErrorReason; error: string };

export function normalizeSessionTitle(title: unknown): SessionTitleValidationResult {
  if (typeof title !== "string") {
    return {
      ok: false,
      reason: "invalid",
      error: "title must be a non-empty string",
    };
  }

  const trimmed = title.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: "invalid",
      error: "title must be a non-empty string",
    };
  }

  if (trimmed.length > 200) {
    return {
      ok: false,
      reason: "invalid",
      error: "title must be 200 characters or fewer",
    };
  }

  return { ok: true, title: trimmed };
}

/** Longest fallback title derived from a prompt when the harness suggests none. */
export const FALLBACK_SESSION_TITLE_MAX_LENGTH = 80;

const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

/**
 * Derive a session title from a prompt's text: first line with words in it,
 * links dropped (a pasted link is not a name), whitespace collapsed,
 * truncated on a word boundary where one exists. Returns null when the prompt
 * has no usable text, such as a prompt that is only a link.
 */
export function deriveFallbackSessionTitle(content: string): string | null {
  const line = content
    .split(/\r?\n/)
    .map((part) => part.replace(URL_PATTERN, " ").replace(/\s+/g, " ").trim())
    .find((part) => /[\p{L}\p{N}]/u.test(part));
  if (!line) return null;
  if (line.length <= FALLBACK_SESSION_TITLE_MAX_LENGTH) return line;
  const cut = line.slice(0, FALLBACK_SESSION_TITLE_MAX_LENGTH);
  const boundary = cut.lastIndexOf(" ");
  const head = boundary > FALLBACK_SESSION_TITLE_MAX_LENGTH / 2 ? cut.slice(0, boundary) : cut;
  return `${head.trimEnd()}…`;
}

/** Whether a title is the fallback one of these prompts would give. */
export function isFallbackSessionTitle(title: string, prompts: readonly string[]): boolean {
  const current = title.trim();
  return prompts.some((prompt) => deriveFallbackSessionTitle(prompt) === current);
}
