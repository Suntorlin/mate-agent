// Maps the model Claude Code asks for to an OpenRouter model.
// A versioned Claude model goes to the same model on OpenRouter ("claude-opus-5-5" ->
// "anthropic/claude-opus-5.5"): Claude Code shapes each request for the model it believes it
// runs, and an older model rejects a newer one's request features.
// Any other name goes through the map, an ordered JSON object: every key except "default" is a
// case-insensitive substring of the requested model; the first match wins, otherwise "default".
// An LLM_MODEL_MAP replaces the whole default map; it may also name models other than Claude
// that OpenRouter serves on the same Anthropic Messages endpoint ({"gpt-5": "openai/gpt-5"}).

export type ModelMap = Readonly<Record<string, string>>;

export const DEFAULT_MODEL_MAP: ModelMap = Object.freeze({
  opus: "anthropic/claude-opus-5.5",
  haiku: "anthropic/claude-haiku-4.5",
  default: "anthropic/claude-sonnet-5.5",
});

export function parseModelMap(raw: string | undefined): ModelMap {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MODEL_MAP;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM_MODEL_MAP must be a JSON object of substring -> model");
  }
  const entries = Object.entries(parsed);
  if (!entries.every(([, value]) => typeof value === "string" && value !== "")) {
    throw new Error("LLM_MODEL_MAP values must be non-empty strings");
  }
  const map = Object.fromEntries(entries) as Record<string, string>;
  if (!map.default) throw new Error('LLM_MODEL_MAP must include a "default" entry');
  return Object.freeze(map);
}

// claude-<family>-<major>[-<minor>][-<yyyymmdd>]
const VERSIONED_CLAUDE_MODEL = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

export function mapModel(requested: unknown, map: ModelMap, forceDefault: boolean): string {
  if (forceDefault || typeof requested !== "string") return map.default;
  const lower = requested.toLowerCase();
  const versioned = VERSIONED_CLAUDE_MODEL.exec(lower);
  if (versioned) {
    const [, family, major, minor] = versioned;
    return `anthropic/claude-${family}-${minor ? `${major}.${minor}` : major}`;
  }
  const hit = Object.keys(map).find(
    (key) => key !== "default" && lower.includes(key.toLowerCase())
  );
  return hit ? map[hit] : map.default;
}
