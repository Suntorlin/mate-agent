/**
 * The block a session's agent reads at its start (`mem context`, run by the SessionStart hook),
 * rendered from the user's current entries (docs/USER_MEMORY.md).
 *
 * The profile comes first ("About the user"). The block stays within
 * USER_MEMORY_LIMITS.injectionTokens (estimateTokens). Over budget it gives up,
 * in this order: projects beyond the newest three, lessons oldest first,
 * unconfirmed entries oldest first, unlocked preferences oldest first. Should
 * the rest still not fit, the projects, the recent summary, the locked
 * preferences and last the profile go the same way, so the block never exceeds
 * the budget.
 */

import {
  estimateTokens,
  USER_MEMORY_LIMITS,
  type UserMemoryContextCounts,
  type UserMemoryEntry,
} from "@open-inspect/shared/types/user-memory";

/** The newest lessons the block starts from; older ones are left to recall. */
export const USER_MEMORY_CONTEXT_LESSONS = 10;
/** The newest projects the block keeps; older ones are left to recall. */
export const USER_MEMORY_CONTEXT_PROJECTS = 3;

/** What the agent reads when there is no memory yet. */
export const USER_MEMORY_EMPTY_CONTEXT =
  "No memory is saved for this user yet. Record lasting facts about them with `mem` (see the memory skill).";
/** What the agent reads when the user paused memory. */
export const USER_MEMORY_PAUSED_CONTEXT =
  "The user has paused memory: do not use their memory or record anything with `mem` in this session.";

const HEADER = [
  "<user-memory>",
  "Saved for this user, who can see and edit it.",
  "Use it without asking again for what is already here.",
];
const FOOTER = [
  "Record lasting facts with `mem` (see the memory skill); search older ones with `mem search <words>`.",
  "</user-memory>",
];
const UNCONFIRMED_HEADING = "## Unconfirmed (use lightly, the user has not approved these)";

export interface UserMemoryContext {
  text: string;
  entryIds: string[];
  counts: UserMemoryContextCounts;
}

type ContextEntry = Pick<
  UserMemoryEntry,
  "id" | "key" | "layer" | "content" | "status" | "locked" | "updatedAt"
>;

interface Selection {
  profile: ContextEntry[];
  recent: ContextEntry | null;
  preferences: ContextEntry[];
  lessons: ContextEntry[];
  projects: ContextEntry[];
  pending: ContextEntry[];
}

const newestFirst = (left: ContextEntry, right: ContextEntry) =>
  right.updatedAt - left.updatedAt || left.key.localeCompare(right.key);

function oldestFirst(entries: readonly ContextEntry[]): ContextEntry[] {
  return [...entries].sort((left, right) => newestFirst(right, left));
}

function entryLine(entry: ContextEntry): string {
  return `- ${entry.key}: ${entry.content}${entry.locked ? " (locked)" : ""}`;
}

function select(entries: readonly ContextEntry[]): Selection {
  const active = entries.filter((entry) => entry.status === "active");
  const byLayer = (layer: ContextEntry["layer"]) =>
    active.filter((entry) => entry.layer === layer).sort(newestFirst);
  return {
    profile: byLayer("profile").sort((left, right) => left.key.localeCompare(right.key)),
    recent: byLayer("recent").find((entry) => entry.key === "recent.summary") ?? null,
    preferences: byLayer("preference").sort(
      (left, right) => Number(right.locked) - Number(left.locked) || newestFirst(left, right)
    ),
    lessons: byLayer("lesson").slice(0, USER_MEMORY_CONTEXT_LESSONS),
    projects: byLayer("project").slice(0, USER_MEMORY_CONTEXT_PROJECTS),
    pending: entries
      .filter((entry) => entry.status === "pending" && entry.layer !== "recent")
      .sort(newestFirst),
  };
}

function render(selection: Selection, dropped: ReadonlySet<string>): string {
  const keep = (list: readonly ContextEntry[]) => list.filter((entry) => !dropped.has(entry.id));
  const lines = [...HEADER];
  const section = (heading: string, body: readonly string[]) => {
    if (body.length > 0) lines.push(heading, ...body);
  };
  const recent =
    selection.recent && !dropped.has(selection.recent.id)
      ? selection.recent.content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => `- ${line}`)
      : [];
  section("## About the user", keep(selection.profile).map(entryLine));
  section("## Now", recent);
  section("## Preferences", keep(selection.preferences).map(entryLine));
  section("## Lessons", keep(selection.lessons).map(entryLine));
  section("## Recent projects", keep(selection.projects).map(entryLine));
  section(UNCONFIRMED_HEADING, keep(selection.pending).map(entryLine));
  lines.push(...FOOTER);
  return lines.join("\n");
}

/** Entry ids in the order the budget gives them up. */
function dropOrder(selection: Selection): string[] {
  const ids = (list: readonly ContextEntry[]) => list.map((entry) => entry.id);
  return [
    ...ids(oldestFirst(selection.lessons)),
    ...ids(oldestFirst(selection.pending)),
    ...ids(oldestFirst(selection.preferences.filter((entry) => !entry.locked))),
    // Beyond the order above, only so the block always fits.
    ...ids(oldestFirst(selection.projects)),
    ...(selection.recent ? [selection.recent.id] : []),
    ...ids(oldestFirst(selection.preferences.filter((entry) => entry.locked))),
    ...ids(oldestFirst(selection.profile)),
  ];
}

/**
 * Render the session-start block for the current `entries` (any order; forgotten and lapsed
 * entries must already be left out).
 */
export function renderUserMemoryContext(
  entries: readonly ContextEntry[],
  budgetTokens: number = USER_MEMORY_LIMITS.injectionTokens
): UserMemoryContext {
  const selection = select(entries);
  const included = [
    ...selection.profile,
    ...(selection.recent ? [selection.recent] : []),
    ...selection.preferences,
    ...selection.lessons,
    ...selection.projects,
    ...selection.pending,
  ];
  if (included.length === 0) {
    return {
      text: USER_MEMORY_EMPTY_CONTEXT,
      entryIds: [],
      counts: countsOf(selection, new Set()),
    };
  }

  // Dropping more never adds tokens, so the fewest drops that fit can be searched for.
  const order = dropOrder(selection);
  const fits = (drops: number) =>
    estimateTokens(render(selection, new Set(order.slice(0, drops)))) <= budgetTokens;
  let low = 0;
  let high = order.length;
  if (!fits(high)) low = high;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) high = middle;
    else low = middle + 1;
  }
  const dropped = new Set(order.slice(0, low));
  return {
    text: render(selection, dropped),
    entryIds: included.map((entry) => entry.id).filter((id) => !dropped.has(id)),
    counts: countsOf(selection, dropped),
  };
}

function countsOf(selection: Selection, dropped: ReadonlySet<string>): UserMemoryContextCounts {
  const kept = (list: readonly ContextEntry[]) =>
    list.filter((entry) => !dropped.has(entry.id)).length;
  return {
    profile: kept(selection.profile),
    recent: selection.recent !== null && !dropped.has(selection.recent.id),
    preferences: kept(selection.preferences),
    lessons: kept(selection.lessons),
    projects: kept(selection.projects),
    pending: kept(selection.pending),
  };
}
