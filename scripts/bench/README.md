# E2B vs Vercel Sandbox benchmark

Runs the same media render step (`workload.sh`) on both providers at 4 vCPU / 8 GB, then pauses
(E2B) or stops (Vercel) the sandbox, resumes it and checks whether a file and a running process
survived. Results are appended to `results.jsonl`.

```bash
npm ci
node compare.mjs e2b
VERCEL_TEAM_ID=team_… VERCEL_PROJECT_ID=prj_… node compare.mjs setup-vercel   # once
VERCEL_TEAM_ID=team_… VERCEL_PROJECT_ID=prj_… node compare.mjs vercel
```

`verify-snapshot.mjs <snapshotId>` checks a Vercel snapshot's media toolchain and renders the sample
timeline.

Keys are read from the macOS Keychain only (`e2b`/`e2b-api-key`, `vercel`/`vercel-sandbox-token`).
The E2B side uses the Open-Inspect template (Debian + `install/media.sh`); the Vercel side uses
Vercel's Ubuntu-based `node:24` image with the same packages (`setup-vercel.sh`), snapshotted once.
