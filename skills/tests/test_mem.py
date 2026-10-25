"""The built-in skills describe the platform's memory, kept by `mem` (stdlib unittest; pytest also
runs it). The command itself is tested in packages/sandbox-runtime."""

import unittest
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[2] / "skills/builtin"


class SkillsDescribePlatformMemoryTest(unittest.TestCase):
    def test_no_skill_points_at_file_based_memory(self):
        stale = ["MEMORY.md", "recipes.md", "failures.md", "assets.md"]
        stale += [f"mem {command}" for command in ("add", "replace", "prune", "lesson")]
        # HyperFrames' own skills (vendored as HeyGen ships them, see hyperframes/NOTICE.md) use
        # "recipes.md" for their own presets, not memory files.
        vendored = {"faceless-explainer", "media-use"} | {
            path.parent.name for path in SKILLS.glob("hyperframes*/SKILL.md")
        }
        for skill in sorted(SKILLS.glob("*/SKILL.md")) + sorted(SKILLS.glob("*/references/*.md")):
            if skill.relative_to(SKILLS).parts[0] in vendored:
                continue
            text = skill.read_text()
            for phrase in stale:
                self.assertNotIn(phrase, text, f"{skill.relative_to(SKILLS)} mentions {phrase}")


if __name__ == "__main__":
    unittest.main()
