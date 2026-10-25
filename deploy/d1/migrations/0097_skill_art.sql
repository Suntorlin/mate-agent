-- The drawn cover chosen for a skill that has no example output: JSON
-- {"gesture","base"?,"seed"?}. The owner sets it on a personal skill; the
-- official-skills sync copies it from the published catalog.
ALTER TABLE skills ADD COLUMN art_json TEXT;
