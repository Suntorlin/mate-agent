# terraform/

Build scripts of the sandbox providers, one module per provider. They are not applied with Terraform
for the Creative Agent engine (the Worker is deployed with Wrangler, see
[deploy/cloudflare](../deploy/cloudflare/README.md)); `packages/sandbox-images` hashes each module's
files into the sandbox image's build key, and the image workflow runs their `scripts/`.

| Module                 | What it holds                                                                     |
| ---------------------- | --------------------------------------------------------------------------------- |
| `vercel-sandbox-infra` | `build-base-snapshot.sh`: the Vercel base snapshot (the provider the engine uses) |
| `modal-app`            | Modal app deploy script                                                           |
| `daytona-infra`        | Daytona snapshot build                                                            |
| `e2b-infra`            | E2B template build                                                                |
| `opencomputer-infra`   | OpenComputer template build                                                       |

The D1 migrations are in [deploy/d1/migrations](../deploy/d1/migrations).
