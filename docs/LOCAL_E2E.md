# Local end-to-end check

`npm run verify` proves the code; it does not prove that the stack works. This is the procedure that
does: bring up every service on this machine, drive them through the reference product (Demo Studio)
with a real model, and read the result. It takes about five minutes and a few cents of OpenRouter
spend. Nothing leaves the machine except the model calls.

Run it before merging a change to the engine, the gateway, the data plane, the sandbox runtime, the
skills, or Demo Studio, and after upgrading a dependency of any of them.

## What it covers

Two scripts, both against the running stack. The API script (`e2e-demo.mjs`) is what a browser does
minus the browser; the UI script (`e2e-ui.mjs`) is a real Chromium. Scenarios marked **model** call
a real model and cost a few cents; the others cost nothing.

**API (`npm run e2e:local`)**

| Scenario             | What it proves                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signup`             | Accounts: sign-up, cookie sign-in, the signup credits                                                                                                       |
| `conversation`       | The product signs as `app` and the engine opens a session for the user                                                                                      |
| `validation`         | Short passwords, bad emails, duplicates, empty and oversized prompts are refused with the right status; a wrong password and an unknown email look the same |
| `isolation`          | Another user gets 404 on every route of someone else's conversation, and sees none in their list                                                            |
| `engine-auth`        | The token mint and the MCP endpoint refuse no, wrong and borrowed credentials (a web cookie is not an MCP token)                                            |
| `tools`              | MCP protocol, the four tools, notes private per user, bad input refused, the generated picture escapes the prompt and is charged                            |
| `out-of-credits`     | At zero credits a prompt is refused (402); a priced tool that cannot be paid takes nothing                                                                  |
| `inline` (model)     | A conversational prompt is answered inline (no sandbox) and charged                                                                                         |
| `mcp` (model)        | The model calls the product's tools through minted tokens                                                                                                   |
| `concurrent` (model) | A second prompt while a turn runs is refused (409) and nothing is charged twice                                                                             |
| `paid-tool` (model)  | `generate_image` takes its credits on top of the model cost                                                                                                 |
| `sandbox` (model)    | A prompt that needs a computer starts a Docker sandbox, reaches the model through the gateway, publishes a page                                             |
| `preview` (model)    | The page is served from the product with `Content-Security-Policy: sandbox`                                                                                 |
| `credits` (model)    | Every turn is settled and the balance only went down                                                                                                        |

**Browser (`npm run e2e:ui`)**: each scenario starts in its own browser context.

| Scenario                  | What it proves                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `auth-errors`             | Duplicate and wrong-password errors in words, the mode toggle, sign-out                                                        |
| `first-run`               | Empty state, starting a chat, the suggestion chips                                                                             |
| `routing`                 | Reload keeps the chat and the Me page, Back works, an unknown address and another user's chat id land safely                   |
| `keyboard`                | Enter sends, Shift+Enter adds a line, Send is off while empty, Tab moves focus                                                 |
| `theme`                   | Dark, Light and System switch at once, persist across reloads, System follows the OS, a choice beats the OS                    |
| `responsive`              | Resizing between desktop and phone swaps the rail and the tab bar and keeps the open chat                                      |
| `phone-nav`               | Phone screens: list, chat with a back button, Me; every tappable target on Me is at least 44px                                 |
| `accessibility`           | Every control has a name, `<html lang>`, visible focus ring                                                                    |
| `out-of-credits-ui`       | At zero credits the composer is off, says why, and Send is off                                                                 |
| `inline-chat` (model)     | An answer streams in, names the chat, charges credits, locks Send while it runs                                                |
| `stop` (model)            | Stop ends a long turn and gives the composer back                                                                              |
| `unsafe-text` (model)     | HTML and `javascript:` links in a prompt or reply never become markup                                                          |
| `long-text` (model)       | A 1500-character word and CJK text wrap on a phone instead of overflowing                                                      |
| `multi-chat` (model)      | Two chats keep their own history, newest first                                                                                 |
| `sandbox-preview` (model) | A published page opens in the preview and cannot reach the app (`parent.document` is blocked), download link, close and reopen |
| `phone-preview` (model)   | On a phone the preview is a sheet: it opens itself, Escape and the button close it                                             |

Not covered: OpenCode (other providers), the Vercel or Cloudflare deployments, a restart of a
service in the middle of a turn, real phones (the safe-area insets), and pixel-level appearance
(look at screenshots with `--shots`).

## Prerequisites

- Node 24 (`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`), `npm ci`, Docker running.
- For the browser script only: Chromium for Playwright, once: `npx playwright-core install chromium`
  (`playwright-core` is a dev dependency; `E2E_CHROMIUM_PATH` points at a browser you already have).
- An OpenRouter key in the macOS keychain item named by `OPENROUTER_KEYCHAIN_SERVICE` in
  `.env.local`, or `OPENROUTER_API_KEY` exported. It is read at start and never written to a file.

## Procedure

```bash
scripts/local/env.sh        # once; ENGINE_PORT, GATEWAY_PORT, DATAPLANE_PORT,
                            # LOCAL_OBJECT_STORE_PORT, DEMO_PORT move the defaults
                            # when another stack already holds them
docker build -f packages/docker-dataplane/sandbox.Dockerfile -t agent-engine-sandbox:local \
  packages/sandbox-runtime  # again after changing packages/sandbox-runtime or the skills

scripts/local/stack.sh up   # object store, gateway, data plane, control plane, Demo Studio
npm run e2e:local           # the API scenarios; exit 0 only if all pass
npm run e2e:ui              # the browser scenarios (needs Playwright, see below)
scripts/local/stack.sh down
```

`stack.sh status` shows what is running, `stack.sh logs [service]` the last lines of a service's log
(`.local/logs/`). Both scripts take `--only a,b` (the API script always runs `signup` and
`conversation` first), `--no-model` (only the scenarios that cost nothing, about a second for the
API script), and the API script `--json report.json`; the browser script `--shots dir/` (a
screenshot per scenario).

A passing run ends with `E2E OK  14/14 scenarios` and `E2E UI OK  16/16 scenarios`. Check the table,
not only the verdict: `inline` must say `runtime inline`, `sandbox` a sandbox runtime and an
artifact name.

## If it fails

1. The failing line names the scenario and what it expected. Read the service logs for that time:
   `scripts/local/stack.sh logs control-plane` (sessions, turns), `gateway` (model calls),
   `dataplane` (sandbox containers), `demo-app` (product).
2. A sandbox scenario that never settles: `docker ps` shows the `ae-sandbox-*` container;
   `docker logs` it. Rebuild the image if you changed the runtime.
3. `port ... is held by something else`: another stack owns that port. Recreate `.env.local` with
   other ports (delete it and run `env.sh` with the port variables) rather than stopping the other
   stack.
4. A scenario that flakes is a bug in the engine or the script, not something to retry until green:
   find the cause.

## Keeping it honest

- A scenario asserts an observable fact (the reply, the runtime, the charge, the artifact), never
  that a call returned 200.
- New product behaviour that crosses the engine boundary gets a scenario in
  `scripts/local/e2e-demo.mjs`; behaviour in the browser gets one in `e2e-ui.mjs`; behaviour inside
  one package gets a unit or integration test there.
- Each API scenario may rely on the ones before it (`validation` and the model scenarios share user
  A and one conversation); the browser scenarios are independent.
- A scenario that costs nothing should not call a model. Make a state the model cannot be asked for
  (no credits, another user, a bad token) with the API, as `out-of-credits` does.
- When a scenario fails, decide first whether the product or the script is wrong. Both happened
  while writing these: the headings of the pages were not headings, and the theme control was 36px
  on a phone (product bugs, fixed); a wait matched text in the sidebar instead of the chat (script
  bug).
