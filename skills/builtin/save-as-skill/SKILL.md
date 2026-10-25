---
name: save-as-skill
description:
  Turn what was made in this session into a reusable skill in the user's own library, so their
  future sessions can do it again. Use when the user asks to save this as a skill, keep this
  workflow, make this repeatable, "存成技能" or similar.
---

# save-as-skill

The user wants the way this session worked to become one of their skills. Distill it, write it as an
Agent Skill, and save it with `save-skill` (on PATH). Saved skills are private to the user and are
installed into every new session they start; saving again under the same name replaces the old
version.

## 1. Distill

Look back over the session and keep only what would make the next run better:

- the goal and the kind of input it starts from (a reference link, a product photo, a script…);
- the steps that worked, in order, with the decisions that mattered: aspect ratio, length, shot
  count, pacing, caption style, voice, music, models and their key parameters, prompt patterns;
- the user's corrections and stated preferences ("always a male voice", "no emoji in captions");
- what failed and what to do instead.

Leave out anything tied to this one run: file paths, generation or artifact ids, timestamps, credit
totals, logs, the transcript itself. Keep reusable ids only when the user will want them every time
(an approved voice id, a logo's object key) and say what each one is. Never include tokens, keys or
signed URLs.

Generalize: replace this run's specifics with what to ask for or look for ("the product name", "the
reference's hook"). If something needs the user's input at the start, say so in the first step.

**Compile the fixed part into a script.** Prose instructions make the next session reason through
every step again; a script makes it run them. Wherever this session settled on an exact command
sequence that would be the same next time — an ffmpeg filter chain, a render invocation, a
conversion pipeline — put it in `scripts/run.sh` (or several named scripts) with the variable parts
as arguments or variables at the top, and shrink the matching SKILL.md steps to: what each parameter
means, when to run the script, and how to check its output. Keep as prose only what genuinely needs
judgment each time (creative choices, quality calls, when to deviate). A skill whose fixed work
lives in scripts is cheaper and more repeatable every time it is used.

## 2. Write

Create a directory named after the skill, outside every repository, e.g. `/tmp/skills/<name>/`:

```
<name>/
  SKILL.md          # required
  references/…      # optional: longer notes, example storyboards, prompt banks
  scripts/…         # optional: deterministic helpers that worked this session (stdlib only)
```

`SKILL.md` starts with YAML frontmatter:

```markdown
---
name: product-ad-15s
description:
  Make a 15-second vertical product ad from one product photo, in three shots with a hook in the
  first second, captions and a voiceover in the user's language. Use when the user wants a short ad
  for a product.
metadata:
  display_name: 15 秒产品广告
  summary.zh-CN: 一张产品图，做成 15 秒竖版广告
  display_name.en: 15-second product ad
  summary.en: A 15-second vertical ad from one product photo
  display_name.ja: 15秒の商品広告
  summary.ja: 商品写真1枚から15秒の縦型広告を作る
  # …and es, pt, ru, fr, de, ar, ko the same way
---

# 15 秒产品广告

…the steps…
```

- `metadata.display_name`: the name the user sees on their Skills page and in the composer. If the
  user named the skill, use their name exactly as they said it, in their language ("口播一键出片");
  otherwise write a short one in the language they work in. One line, at most 64 characters; quote
  it if it contains `:` or `#`.
- `metadata.display_name.<language>` and `metadata.summary.<language>`: the same name, and one line
  about what the skill makes, for people who read another language. Write both for each of `en`,
  `es`, `pt`, `ja`, `ru`, `fr`, `de`, `ar`, `zh-CN` and `ko`; the Skills page shows the reader's
  own. The summary is for a person choosing a skill, not for a session deciding when to use it: say
  what comes out, in a few words (at most 300 characters). In the user's own language the name stays
  exactly the `display_name`, so only its summary is needed there. Do not ask the user for these and
  do not list them back.
- `name`: the skill's internal id, which sessions load it by. Lowercase letters, numbers and single
  hyphens, at most 64 characters, must not contain "claude" or "anthropic", and must not be
  `viral-remake`, `memory`, `preview` or `save-as-skill`. Short and specific: `cafe-brand-15s`, not
  `my-video-skill`; for a name in another language, a short English or pinyin rendering
  (`koubo-oneclick`). The user never needs to see it.
- `description`: what it does **and** when to use it, in one to three sentences (at most 1024
  characters, ideally under 200). This is all a future session sees until the skill is used, so name
  the trigger situations plainly. A colon followed by a space inside it breaks the frontmatter:
  reword, or quote the whole value.
- Body: the distilled steps as direct instructions, under 500 lines. Point to the other skills
  instead of repeating them ("generate with the product's media tools", "publish with the preview
  skill", "use viral-remake's renderer"). Put long material in `references/` and say when to read
  it.
- Write in the language the user works in.

Limits: at most 100 files, 256 KB per file, 1 MB in total, text files only. Files under `scripts/`
keep their executable bit.

## 3. Save

If this session published a final video or image to the preview pane, pass its `artifactId` (from
`media-preview`'s output) as the example shown with the skill:

```bash
save-skill /tmp/skills/product-ad-15s --cover <artifactId> --cover-kind video
save-skill /tmp/skills/product-ad-15s          # no example output
```

It prints JSON with the saved `name`, its `displayName` and whether it was `created` or updated.
Then tell the user, in one or two sentences in their language, what the skill is called (its display
name), what it will do next time, and that it is in their Skills page and in every new session. Do
not mention the internal `name` or say that skill names must be in English: the user sees the name
they chose. Do not paste the SKILL.md unless asked.

If the user only says "save this", pick the names and description yourself; do not ask them to. To
rename a saved skill, save it again under the same `name` with the new `metadata.display_name`.
