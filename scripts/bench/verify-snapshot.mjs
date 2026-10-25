// Boot a Vercel sandbox from a snapshot and check the media toolchain: OS and glibc, ffmpeg,
// CJK and emoji fonts, render, skills, then render the starter's 8 s sample timeline.
//
//   node verify-snapshot.mjs <snapshotId>
//
// Same Keychain and environment conventions as compare.mjs. On the Open-Inspect base snapshot
// (Amazon Linux 2023, glibc 2.34) the render fails with "GLIBC_2.35 not found" from Remotion's
// compositor; on Vercel's Ubuntu images it succeeds.
import { execFileSync } from "node:child_process";
import { Sandbox } from "@vercel/sandbox";

const snapshotId = process.argv[2];
const { VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
if (!snapshotId || !teamId || !projectId) {
  console.error(
    "usage: VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… node verify-snapshot.mjs <snapshotId>"
  );
  process.exit(64);
}
const token = execFileSync(
  "/usr/bin/security",
  ["find-generic-password", "-a", "vercel", "-s", "vercel-sandbox-token", "-w"],
  {
    encoding: "utf8",
  }
).trim();

const CHECK = `export PATH=/opt/openinspect/node/bin:/usr/local/bin:$PATH
head -2 /etc/os-release; ldd --version | head -1
ffmpeg -hide_banner -version | head -1
echo "cjk_fonts=$(fc-list | grep -c 'Noto Sans CJK') emoji_fonts=$(fc-list | grep -c 'Noto Color Emoji')"
ls -l /usr/local/bin/render; ls /app/sandbox_runtime/skills 2>/dev/null | tr '\\n' ' '; echo
work=$(mktemp -d); bash /opt/media/remotion-starter/examples/make-sample-assets.sh "$work" >/dev/null
render "$work/timeline.json" "$work/out.mp4" >"$work/render.log" 2>&1 || { grep -m3 -E 'GLIBC|Error' "$work/render.log"; exit 1; }
ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/out.mp4"`;

const sandbox = await Sandbox.create({
  token,
  teamId,
  projectId,
  source: { type: "snapshot", snapshotId },
  resources: { vcpus: 4 },
  timeout: 15 * 60 * 1000,
  persistent: false,
});
try {
  const result = await sandbox.runCommand({ cmd: "bash", args: ["-c", CHECK], sudo: true });
  console.log(await result.stdout());
  console.log(result.exitCode === 0 ? "render: ok" : "render: FAILED");
  process.exitCode = result.exitCode;
} finally {
  await sandbox.stop();
}
