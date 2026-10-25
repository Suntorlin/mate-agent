"""Black-box tests for the save-as-skill skill's `save-skill` command."""

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import ClassVar

SAVE_SKILL = (
    Path(__file__).resolve().parents[2] / "skills/builtin/save-as-skill/scripts/save-skill"
)


class ControlPlane(BaseHTTPRequestHandler):
    """Records one request and answers with the configured status and body."""

    requests: ClassVar[list] = []
    status = 201
    reply: ClassVar[dict] = {"skill": {"name": "cafe-ad"}, "created": True}

    def do_POST(self):
        length = int(self.headers["Content-Length"])
        ControlPlane.requests.append(
            {
                "path": self.path,
                "auth": self.headers["Authorization"],
                "body": json.loads(self.rfile.read(length)),
            }
        )
        body = json.dumps(ControlPlane.reply).encode()
        self.send_response(ControlPlane.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class SaveSkillTest(unittest.TestCase):
    def setUp(self):
        ControlPlane.requests = []
        ControlPlane.status = 201
        ControlPlane.reply = {
            "skill": {"name": "cafe-ad", "displayName": "咖啡店广告"},
            "created": True,
        }
        self.server = HTTPServer(("127.0.0.1", 0), ControlPlane)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self._tmp = tempfile.TemporaryDirectory()
        self.skill = Path(self._tmp.name) / "cafe-ad"
        (self.skill / "scripts").mkdir(parents=True)
        (self.skill / "SKILL.md").write_text("---\nname: cafe-ad\ndescription: d\n---\n# Cafe\n")
        (self.skill / "scripts" / "cut.sh").write_text("#!/bin/sh\n")
        (self.skill / "scripts" / "cut.sh").chmod(0o755)
        (self.skill / "references").mkdir()
        (self.skill / "references" / "notes.md").write_text("三个镜头")
        (self.skill / ".DS_Store").write_bytes(b"\x00\x01")
        self.env = {
            "PATH": os.environ["PATH"],
            "CONTROL_PLANE_URL": f"http://127.0.0.1:{self.server.server_port}",
            "SANDBOX_AUTH_TOKEN": "sandbox-token",
            "SESSION_CONFIG": json.dumps({"sessionId": "s1"}),
        }

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self._tmp.cleanup()

    def run_cli(self, *args, env=None):
        return subprocess.run(
            [sys.executable, str(SAVE_SKILL), *args],
            capture_output=True,
            text=True,
            env=env or self.env,
            timeout=30,
        )

    def test_posts_every_text_file_with_the_sandbox_token(self):
        result = self.run_cli(str(self.skill), "--cover", "artifact-9", "--cover-kind", "video")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {"name": "cafe-ad", "displayName": "咖啡店广告", "created": True},
        )
        self.assertIn("咖啡店广告", result.stdout)
        [request] = ControlPlane.requests
        self.assertEqual(request["path"], "/sessions/s1/saved-skills")
        self.assertEqual(request["auth"], "Bearer sandbox-token")
        files = {file["path"]: file for file in request["body"]["files"]}
        self.assertEqual(sorted(files), ["SKILL.md", "references/notes.md", "scripts/cut.sh"])
        self.assertTrue(files["scripts/cut.sh"]["executable"])
        self.assertFalse(files["references/notes.md"]["executable"])
        self.assertEqual(files["references/notes.md"]["content"], "三个镜头")
        self.assertEqual(request["body"]["coverArtifactId"], "artifact-9")
        self.assertEqual(request["body"]["coverKind"], "video")

    def test_reports_the_control_planes_reason(self):
        ControlPlane.status = 400
        ControlPlane.reply = {"error": "SKILL.md frontmatter has no description"}
        result = self.run_cli(str(self.skill))
        self.assertEqual(result.returncode, 1)
        self.assertIn("no description", result.stderr)

    def test_refuses_what_the_control_plane_would_refuse(self):
        (self.skill / "SKILL.md").unlink()
        self.assertIn("no SKILL.md", self.run_cli(str(self.skill)).stderr)
        (self.skill / "SKILL.md").write_text("---\nname: cafe-ad\n---\n")
        (self.skill / "cover.png").write_bytes(b"\x89PNG\r\n\x1a\n\xff")
        self.assertIn("not UTF-8", self.run_cli(str(self.skill)).stderr)
        (self.skill / "cover.png").unlink()
        env = {**self.env, "SANDBOX_AUTH_TOKEN": ""}
        self.assertIn("SANDBOX_AUTH_TOKEN", self.run_cli(str(self.skill), env=env).stderr)
        self.assertEqual(ControlPlane.requests, [])


if __name__ == "__main__":
    unittest.main()
