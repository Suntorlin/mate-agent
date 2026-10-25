/**
 * Keyword matching over memory entries, for per-turn recall (`mem
 * recall` / `search`) and for "forget everything about …".
 *
 * Text is reduced to tokens: lowercase ASCII words of two or more characters,
 * and every two-character run of CJK text (Chinese, Japanese and Korean have
 * no spaces, and two characters are the shortest unit that still means
 * something). An entry matches a query by the tokens they share, its key
 * included, so `voice` finds `pref.voice`.
 */

import type { UserMemoryEntry, UserMemoryLayer } from "@open-inspect/shared/types/user-memory";

const ASCII_WORD = /[a-z0-9]+/g;
// The ranges estimateTokens counts as CJK: kana, CJK ideographs, compatibility ideographs, Hangul.
const CJK_RUN = /[぀-ヿ㐀-鿿豈-﫿가-힯]+/g;

/** How much a match in each layer is worth in recall; layers not listed are never recalled. */
export const USER_MEMORY_RECALL_WEIGHTS: Readonly<Partial<Record<UserMemoryLayer, number>>> = {
  lesson: 1,
  project: 0.8,
  preference: 0.6,
};

export function userMemorySearchTokens(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  for (const word of lower.match(ASCII_WORD) ?? []) {
    if (word.length >= 2) tokens.add(word);
  }
  for (const run of lower.match(CJK_RUN) ?? []) {
    const characters = [...run];
    for (let index = 0; index + 1 < characters.length; index += 1) {
      tokens.add(characters[index]! + characters[index + 1]!);
    }
  }
  return tokens;
}

export interface UserMemoryMatch<Entry> {
  entry: Entry;
  /** Query tokens the entry contains. */
  matched: number;
  score: number;
}

/**
 * The entries sharing at least one token with `query`, best first: by score
 * (matched tokens times the layer's weight, or the bare count without
 * weights), then the most recently updated.
 */
export function matchUserMemory<
  Entry extends Pick<UserMemoryEntry, "key" | "content" | "layer" | "updatedAt">,
>(
  query: string,
  entries: readonly Entry[],
  weights?: Readonly<Partial<Record<UserMemoryLayer, number>>>
): UserMemoryMatch<Entry>[] {
  const wanted = userMemorySearchTokens(query);
  if (wanted.size === 0) return [];
  const matches: UserMemoryMatch<Entry>[] = [];
  for (const entry of entries) {
    const weight = weights ? weights[entry.layer] : 1;
    if (weight === undefined) continue;
    const tokens = userMemorySearchTokens(`${entry.key} ${entry.content}`);
    let matched = 0;
    for (const token of wanted) {
      if (tokens.has(token)) matched += 1;
    }
    if (matched > 0) matches.push({ entry, matched, score: matched * weight });
  }
  return matches.sort(
    (left, right) => right.score - left.score || right.entry.updatedAt - left.entry.updatedAt
  );
}
