// Compare E2B and Vercel Sandbox on the media render workload (workload.sh), same 4 vCPU / 8 GB.
//
//   node compare.mjs setup-vercel   one-time: build the Vercel base snapshot (media toolchain + starter)
//   node compare.mjs e2b            create -> render -> pause -> resume -> persistence check -> kill
//   node compare.mjs vercel         create -> render -> stop -> resume -> persistence check -> delete
//
// Keys come only from the macOS Keychain: account e2b / service e2b-api-key, and
// account vercel / service vercel-sandbox-token. VERCEL_TEAM_ID and VERCEL_PROJECT_ID are not
// secret and come from the environment. Results are appended to results.jsonl.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Sandbox as E2B } from "e2b";
import { Sandbox as Vercel } from "@vercel/sandbox";

const here = new URL(".", import.meta.url).pathname;
const STATE_FILE = `${here}.vercel-base.json`;
const E2B_TEMPLATE = process.env.E2B_TEMPLATE_ID || "6sp7a2j4ygbb2x33e2nq";
const VCPUS = Number(process.env.VCPUS || 4); // Vercel only; the E2B template is fixed at 4 vCPU / 8 GB
const SESSION_MS = 45 * 60 * 1000; // Vercel Hobby session cap; E2B Hobby allows 1 h
const workload = readFileSync(`${here}workload.sh`);
// A detached process plus a file: after resume, which of the two survived?
const PROBE =
  "setsid nohup sleep 86400 >/dev/null 2>&1 < /dev/null & echo $!; echo keep > /tmp/persist-marker";
const check = (pid) =>
  `test -f /tmp/persist-marker && echo file=yes || echo file=no; kill -0 ${pid} 2>/dev/null && echo process=yes || echo process=no`;

const keychain = (account, service) =>
  execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
    encoding: "utf8",
  }).trim();

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return [Math.round(performance.now() - start) / 1000, value];
}

const lastLine = (text) => text.trim().split("\n").pop();

function vercelAuth() {
  const { VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  if (!teamId || !projectId) throw new Error("Set VERCEL_TEAM_ID and VERCEL_PROJECT_ID");
  return { teamId, projectId, token: keychain("vercel", "vercel-sandbox-token") };
}

async function vercelRun(sandbox, cmd, args, extra = {}) {
  const done = await sandbox.runCommand({ cmd, args, ...extra });
  const stdout = await done.stdout();
  if (done.exitCode !== 0)
    throw new Error(`${cmd} ${args.join(" ")} exited ${done.exitCode}: ${await done.stderr()}`);
  return stdout;
}

async function setupVercel() {
  const auth = vercelAuth();
  const starter = execFileSync(
    "tar",
    [
      "--no-xattrs",
      "-czf",
      "-",
      "--exclude=node_modules",
      "-C",
      `${here}../../skills/remotion-starter`,
      ".",
    ],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  const sandbox = await Vercel.create({
    ...auth,
    image: "vercel/sandbox/node:24",
    resources: { vcpus: VCPUS },
    timeout: 30 * 60 * 1000,
    persistent: false,
  });
  const user = (await vercelRun(sandbox, "whoami", [])).trim();
  await sandbox.writeFiles([
    { path: "/tmp/starter.tgz", content: starter },
    { path: "/tmp/setup-vercel.sh", content: readFileSync(`${here}setup-vercel.sh`), mode: 0o755 },
  ]);
  await vercelRun(sandbox, "bash", ["/tmp/setup-vercel.sh", user], {
    sudo: true,
    stdout: process.stderr,
    stderr: process.stderr,
  });
  const snapshot = await sandbox.snapshot({ expiration: 7 * 24 * 60 * 60 * 1000 });
  writeFileSync(STATE_FILE, JSON.stringify({ snapshotId: snapshot.snapshotId, user }));
  console.log(`Vercel base snapshot: ${snapshot.snapshotId}`);
}

async function runE2B() {
  const apiKey = keychain("e2b", "e2b-api-key");
  const [create_s, sandbox] = await timed(() =>
    E2B.create(E2B_TEMPLATE, { apiKey, timeoutMs: 60 * 60 * 1000 })
  );
  try {
    await sandbox.files.write("/tmp/workload.sh", workload.toString());
    const run = await sandbox.commands.run("bash /tmp/workload.sh", { timeoutMs: SESSION_MS });
    const render = JSON.parse(lastLine(run.stdout));
    const pid = (await sandbox.commands.run(PROBE)).stdout.trim().split("\n")[0];
    const before = (await sandbox.commands.run(check(pid))).stdout.trim();
    const [pause_s] = await timed(() => sandbox.pause());
    const [resume_s, resumed] = await timed(() => E2B.connect(sandbox.sandboxId, { apiKey }));
    const after = (await resumed.commands.run(check(pid))).stdout.trim();
    return { provider: "e2b", create_s, ...render, pause_s, resume_s, before, after };
  } finally {
    await E2B.kill(sandbox.sandboxId, { apiKey });
  }
}

async function runVercel() {
  const auth = vercelAuth();
  const { snapshotId } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const name = `render-bench-${Date.now()}`;
  const [create_s, sandbox] = await timed(() =>
    Vercel.create({
      ...auth,
      name,
      source: { type: "snapshot", snapshotId },
      resources: { vcpus: VCPUS },
      timeout: SESSION_MS,
    })
  );
  try {
    await sandbox.writeFiles([{ path: "/tmp/workload.sh", content: workload }]);
    const render = JSON.parse(lastLine(await vercelRun(sandbox, "bash", ["/tmp/workload.sh"])));
    const pid = (await vercelRun(sandbox, "bash", ["-c", PROBE])).trim().split("\n")[0];
    const before = (await vercelRun(sandbox, "bash", ["-c", check(pid)])).trim();
    // Stop on a persistent sandbox snapshots the filesystem on the way down.
    const [pause_s, stopped] = await timed(() => sandbox.stop());
    const [resume_s, resumed] = await timed(async () => {
      const again = await Vercel.get({ ...auth, name });
      await vercelRun(again, "true", []);
      return again;
    });
    const after = (await vercelRun(resumed, "bash", ["-c", check(pid)])).trim();
    await resumed.stop();
    const usage = await Vercel.get({ ...auth, name, resume: false });
    return {
      provider: "vercel",
      create_s,
      ...render,
      pause_s,
      resume_s,
      before,
      after,
      snapshot_mb: Math.round((stopped.snapshot?.sizeBytes ?? 0) / 1e6),
      billed_active_cpu_s: (usage.totalActiveCpuDurationMs ?? 0) / 1000,
      billed_duration_s: (usage.totalDurationMs ?? 0) / 1000,
    };
  } finally {
    await (await Vercel.get({ ...auth, name, resume: false })).delete();
  }
}

const commands = { "setup-vercel": setupVercel, e2b: runE2B, vercel: runVercel };
const command = commands[process.argv[2]];
if (!command) {
  console.error(`usage: node compare.mjs ${Object.keys(commands).join(" | ")}`);
  process.exit(64);
}
const result = await command();
if (result) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...result });
  appendFileSync(`${here}results.jsonl`, `${line}\n`);
  console.log(line);
}
