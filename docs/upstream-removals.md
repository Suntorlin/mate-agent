# What was removed from Open-Inspect, and what was kept on purpose

The engine dropped the parts of Open-Inspect that it does not use. Nothing is lost: the Open-Inspect
commit the engine starts from, `4e5c1f3b`, still has all of it, and it is the parent of the engine's
first commit.

## Removed

| What                                                                        | Files | Where it was                                                                                                                                              |
| --------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public documentation site                                                   | 143   | `packages/docs`, and its Vercel project in `terraform/environments/production`                                                                            |
| Slack, GitHub and Linear bots                                               | 181   | `packages/slack-bot`, `packages/github-bot`, `packages/linear-bot`                                                                                        |
| Terraform production environment and its Cloudflare/Vercel modules          | 46    | `terraform/environments/production`, `terraform/modules/{cloudflare-worker,cloudflare-kv,vercel-project}`                                                 |
| AWS deployment                                                              | 38    | `docker-compose.aws.yml`, `terraform/modules/aws-control-plane`, `terraform/environments/aws-*`, `scripts/{check,deploy}-aws*.sh`, `docs/AWS_BRING_UP.md` |
| Onboarding skill, `.openinspect/setup.sh`, upstream deploy guides, bot docs | 8     | `.claude/skills/onboarding`, `.openinspect`, `docs/{GETTING_STARTED,SETUP_GUIDE}.md`, `docs/integrations`                                                 |

## Bring something back

```bash
git checkout 4e5c1f3b -- packages/slack-bot     # one directory
git show 4e5c1f3b:docker-compose.aws.yml        # read one file
git diff 4e5c1f3b HEAD --stat -- packages/      # what changed since
```

A bot or the docs site is a workspace again as soon as its directory is back (`packages/*`); add its
test step to `.github/workflows/ci.yml` and `scripts/verify.mjs` (a test fails until both agree).
The Terraform production environment was the upstream way to deploy the Worker; the control plane's
cron and queue tests used to read it and now read `deploy/cloudflare/wrangler.staging.jsonc`.

## Kept on purpose, for switching providers later

- **Modal, Daytona, E2B and OpenComputer sandbox providers**: the adapters in
  `packages/control-plane/src/sandbox/providers`, the image targets in `packages/sandbox-images`,
  the build tooling in `packages/{modal,daytona,e2b,opencomputer}-infra` and `terraform/modules`.
  The engine runs on Vercel sandboxes; the CI workflows only exercise those.
- **The older local Docker stack**: `deploy/compose/docker-compose.yml`, its overlays
  (`secrets.yml`, `vercel.yml`, `docker-compose.smoke.yml`) and `docs/CONTROL_PLANE_CONTAINER.md`.
  The daily local stack is `docker-compose.engine.yml`.
