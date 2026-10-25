-- The names and one-liners an admin typed for an official skill, by language:
-- JSON {"<locale>": {"name"?, "description"?}}. The official-skills sync copies
-- it from the published catalog; a skill's own SKILL.md metadata carries the
-- rest and is not stored here.
ALTER TABLE skills ADD COLUMN locales_json TEXT;
