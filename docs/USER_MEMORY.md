# User memory

The engine keeps a memory per user, so an agent remembers across sessions what the user prefers,
what worked for them and what they made. The user can see, edit, lock, undo and pause it.

Types and limits live in `packages/shared/src/types/user-memory.ts`; the tables in
`deploy/d1/migrations/0087_fish_memory.sql`. The code is `packages/control-plane/src/memory`; the
sandbox side is `sandbox_runtime/memory.py` (`mem`).

## Layers

The key's prefix picks the layer. Every entry is one line of at most 300 characters; a project entry
may grow to 600 through appends.

| Layer                         | What it holds                                                          | Who writes                                                           | How the agent reads it                                |
| ----------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| `profile.<field>`             | Who the user is: name, role, what they do, city or time zone, language | The user sets fields; the agent and the extraction only suggest them | First in the session-start block, never by recall     |
| `pref.*`                      | Lasting likes and dislikes                                             | The user, the agent, the extraction                                  | At session start, locked ones first                   |
| `lesson.*`                    | What works for this user, what they turned down and why                | The agent, the extraction                                            | The newest at session start, the rest by recall       |
| `project.<yyyy-mm-dd>.<name>` | One per delivered piece of work: what, how, how it was received        | The agent, the extraction                                            | The newest three at session start, the rest by recall |
| `recent.summary`              | What the user has been doing lately, three lines at most               | The consolidation job only; lapses after 14 days                     | At session start                                      |

Limits: 30 profile fields, 40 preferences, 60 lessons, 500 projects. A new key in a full layer
answers `full`.

## Versions, status, locks

- **Nothing is overwritten.** A change inserts a new version (`relation=updates`, or `extends` for
  an append) with `parent_id` on the one before; `is_latest` moves to it (a unique index keeps one
  current version per key). Old versions stay for export and undo.
- **Forgetting is a soft delete** (`forgotten_at` and a reason); an entry past `forget_after` counts
  as forgotten. A daily job deletes rows forgotten for 30 days and ops older than 180.
- **Status.** What the user wrote (`user_edit`) or said (`said`, written as `user_said`) is
  `active`; so are project records. What the agent or the extraction inferred (`inference`) is
  `pending`: shown at session start as unconfirmed, never recalled, `active` once the user approves.
- **A lock stops the AI, not the user**: a locked key refuses every write and forget that is not
  `user_edit` (`locked`).
- **The profile is the user's**: what the agent or the extraction writes to `profile.*` is always
  `pending`, even when the user said it, until the user approves it. A field the user has set (or
  approved) is refused to them like a locked key, so an unapproved suggestion never hides it; a
  pending suggestion can be replaced by a better one.
- **Pause**: while the user has paused memory, every write answers `paused` and the session-start
  block says only that memory is off.
- **Batches**: every request is one `batch_id` (one `mem` call, one extraction
  `extract:<messageId>`, which also makes it idempotent, one action on the memory page). Undo works
  per batch: new versions go and the previous ones return; forgotten entries come back.
- **Content checks** refuse secrets, signed URLs, logs and raw output, and multi-line text; the
  sandbox's `mem` runs the same checks. Only the consolidation job writes `recent.*`.

## Routes

From the sandbox, with the sandbox token; the memory's owner is the session's owner:

| Method | Path                                             | What it does                                                                          |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| GET    | `/sessions/:id/memory/context`                   | The session-start block, its entry ids and counts; broadcasts `memory_loaded`         |
| GET    | `/sessions/:id/memory/search?q=&limit=&exclude=` | Keyword recall over active preferences, lessons and projects (words; CJK bigrams)     |
| GET    | `/sessions/:id/memory`                           | Every current entry, pending ones included, and whether memory is paused              |
| POST   | `/sessions/:id/memory/ops`                       | `set` / `append` / `forget`, a result per op; broadcasts `memory_updated` for changes |

For the user (signed in, or the product acting for them as `app:<id>`):

| Method | Path                            | What it does                                        |
| ------ | ------------------------------- | --------------------------------------------------- |
| GET    | `/memory`                       | Current entries and whether memory is paused        |
| POST   | `/memory/entries`               | Add an entry (`user_edit`)                          |
| PATCH  | `/memory/entries/:id`           | Change the text (a new version) or the lock         |
| DELETE | `/memory/entries/:id`           | Forget                                              |
| POST   | `/memory/entries/:id/approve`   | Make a pending entry active                         |
| POST   | `/memory/entries/:id/decline`   | Decline, which forgets it                           |
| POST   | `/memory/batches/:batchId/undo` | Undo one batch                                      |
| POST   | `/memory/forget-preview`        | List what a sentence would forget                   |
| POST   | `/memory/forget`                | Forget the ids the preview listed and the user kept |
| POST   | `/memory/clear`                 | Forget everything                                   |
| GET    | `/memory/export`                | Everything, with old versions and forgotten rows    |
| PUT    | `/memory/settings`              | Pause or resume                                     |

## What the agent reads

The SessionStart hook runs `mem context`. The block stays the same for the whole session and is not
part of the system prompt, so it does not break prompt caching:

```
<user-memory>
Saved for this user, who can see and edit it.
Use it without asking again for what is already here.
## About the user
- profile.name: Ada
## Now
- … (recent.summary)
## Preferences
- pref.voice: Male voice (locked)
## Lessons
- lesson.…: …
## Recent projects
- project.2026-10-02.coffee: …
## Unconfirmed (use lightly, the user has not approved these)
- pref.…: …
Record lasting facts with `mem` (see the memory skill); search older ones with `mem search <words>`.
</user-memory>
```

- At most 2,000 estimated tokens. Over that it gives up, in order: projects beyond three, lessons
  oldest first, unconfirmed entries oldest first, unlocked preferences oldest first; the profile
  goes last of all.
- Inline turns (answered without a sandbox) get the same block when there is any memory.
- With no memory it is one line saying `mem` can record some.
- Each prompt, the UserPromptSubmit hook runs `mem recall`: up to five entries the session has not
  been shown yet, matched against the prompt, appended as `<user-memory-recall>`. It skips a
  go-ahead ("continue", "ok"), times out after two seconds and fails silently.

## After a turn

**`user_memory.extract`** runs when a turn ends well (`execution_complete`, not stopped), with
`{ sessionId, ownerUserId, messageId }`.

- Skipped when the batch already exists, memory is paused, the message was only a go-ahead, the
  author is not the owner, or no model is configured.
- The model is Haiku at temperature 0: through the gateway as the user (counted against their
  budget) when there is one, else through the inline runtime's endpoint (`INLINE_LLM_BASE_URL`,
  `INLINE_LLM_API_KEY`) with `MEMORY_MODEL`. 30-second deadline; three tries 60 seconds apart; a
  spent budget (429) is not retried.
- It is shown the turn, the current memory (locked keys marked) and a calendar for today, and
  answers `{ "ops": [...] }` in `mem`'s shape: lasting facts about the user only, `said` only for
  what the user said this turn, at most ten ops, keys in ASCII, dates absolute.
- Its writes are `extractor`; project records are active, the rest pending unless `said`. What the
  user changed, undid or forgot since the turn began, and anything that says much the same (Dice
  similarity of character pairs ≥ 0.6), is left alone (`left_to_user` in the log).
- An applied change broadcasts `memory_updated` and queues a consolidation five minutes later.

**`user_memory.consolidate`** rewrites `recent.summary` (three lines, lapses after 14 days) from the
current preferences, the newest lessons and projects and the last 14 days of changes, unless it ran
in the last 30 minutes.

The extraction eval is `packages/control-plane/scripts/memory-eval.ts` with
`scripts/bench/memory-eval/scenarios.json`.
