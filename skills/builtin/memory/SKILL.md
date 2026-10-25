---
name: memory
description:
  What the platform remembers about this user across sessions (profile, preferences, lessons, past
  projects) and how to add to it with `mem`. Memory arrives by itself at session start; record a
  lasting preference the moment the user states it, and a project line (plus any lesson specific to
  this user) after each finished piece of work.
---

# memory

The platform keeps each user's memory, and the user can see and edit all of it in the product. You
do not manage files:

- The session starts with a memory block: who the user is, what they are working on now, preferences
  (locked ones first), lessons, recent projects and unconfirmed entries. A read-only copy is in
  `/workspace/.memory/context.md`.
- A message may arrive with `<user-memory-recall>` lines added: older entries it is about.
- "User memory could not be loaded this time" means memory was unreachable, not empty: do not treat
  the user as new. Run `mem show`; if that fails too, ask only what the job needs.
- If the block says memory is paused, the user switched it off: record nothing and do not bring
  memory up.

Use what is there without asking again. When a remembered preference shapes the work, say so in a
few words ("配音用了你偏好的男声") and nothing more about how memory works. Only `mem` reaches their
next session; notes you write to files do not.

```bash
mem show                      # profile, preferences, lessons, projects, with locked/pending flags
mem show project              # one layer: profile | preference | lesson | project | recent
mem search 咖啡 片头           # older entries about these words
mem set pref.voice "配音一律用男声，语速偏快" --said
mem set pref.color-grade "Prefers warm grades; turned down teal twice" --inference
mem set project.2026-10-03.coffee-launch "15 s 9:16 launch ad, generated keyframes + i2v, male VO"
mem append project.2026-10-03.coffee-launch "User: loves the hook, wants a 2 s end card" --said
mem set lesson.product-closeups "Their matte bottles look plastic without a softbox in the prompt"
mem set profile.role "Runs a small coffee shop in Osaka" --said
mem forget pref.music --reason "user now picks music per video"
```

Every write prints one line per result: `applied`, `unchanged`, or a refusal with what to do (the
command then exits 1).

## Layers

| key                           | holds                                                                     | write it                                                      |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `pref.<topic>`                | a lasting like or dislike: voice, captions, pacing, music, words to avoid | the moment the user states or confirms it                     |
| `lesson.<topic>`              | what works or fails for this user's content, products or audience         | after a piece of work, when something specific to them showed |
| `project.<yyyy-mm-dd>.<name>` | one line per finished piece: topic, format, look, tools, verdict          | after each finished piece; their later reaction with append   |
| `profile.<field>`             | who the user is: name, role, what they do, city or time zone, language    | when the user mentions it; they approve it                    |
| `recent.summary`              | what they are working on now                                              | never: the platform writes it                                 |

Keys are lowercase (`a-z`, `0-9`, `-`, `_`), one to three parts after the prefix, at most 80
characters. Name a profile field plainly (`profile.name`, `profile.role`, `profile.time_zone`), and
reuse a field that is already there.

Text is one line of at most 300 characters (a project entry 600, so its reactions fit), in the
user's language, readable without this conversation, with absolute dates ("until 2026-10-31", never
"next week").

## Who said it

- `--said`: the user said it themselves in this conversation. It counts at once.
- `--inference`: your own conclusion about their taste ("chose the warmer grade twice"). It stays
  unconfirmed, and is used lightly, until the user approves it.
- Neither: a record of what happened, such as a project line.
- `--ttl-days N` (on `set`): a fact with an end date, such as a campaign or a seasonal look.

`set` on a key that exists writes a new version and keeps the old one, so update the key that holds
a fact instead of adding a near-duplicate; check `mem show` or `mem search` when unsure.

## When to write

1. **The user states a lasting preference or corrects you** ("以后都用男声", "never put emoji in
   captions"): `mem set pref.<topic> "…" --said` in the same turn, on the key that already holds
   that topic if there is one. A request for this piece only is not a preference.
2. **After each finished piece** (the user has it): `mem set project.<yyyy-mm-dd>.<name> "…"` with
   what was actually made, not what was planned. If something specific to this user came out (a
   product that needs a certain shot, a look that suits them, an idea they rejected and why), also
   `mem set lesson.<topic> "…"`. A few lines per piece at most.
3. **The user reacts later** ("结尾太长了", "this one did great"):
   `mem append project.<…> "…" --said`.
4. **The user mentions who they are** (their name, role, what they do, where they are, the language
   they work in): `mem set profile.<field> "…"`. It is a suggestion the user approves; until then
   the profile stays as it is. A field the user has set is theirs: `mem` refuses to change it
   (`locked`), so tell them instead if it looks out of date.
5. **A remembered entry is wrong or stale**: `set` the corrected text, or
   `mem forget <key> --reason "…"`.

## Never user memory

- Know-how true for every user: how tools, models, the sandbox or these skills behave.
- Transcripts, prompts verbatim, logs, command output, ids of one-off results.
- Tokens, keys, passwords and signed URLs (`mem` refuses them). Recurring files belong in the
  library (`library put <file>`).
- Personal data the user did not ask you to remember, and anything about other people.

## Locked entries and refusals

The user locks entries the AI must not change. If a locked entry contradicts what they ask now, do
what they ask for this piece and tell them the saved preference can be changed in the product; do
not try to rewrite or forget it.

| outcome   | what to do                                                                     |
| --------- | ------------------------------------------------------------------------------ |
| `locked`  | the user locked this key: ask them or leave it                                 |
| `full`    | the layer is at its limit: merge related entries with `set`, forget stale ones |
| `paused`  | memory is switched off: record nothing more this session                       |
| `invalid` | fix the key or the text as the message says                                    |
| `missing` | there is nothing under that key: check `mem show`                              |
