# Demo Studio (`packages/demo-app`)

A small but real product on Mate Agent, kept in this repository as the reference for how a product
sits on top of the engine: its own accounts and credits, its own tools and persona over MCP, chat on
one side and a preview of what the agent made on the other. It is a demo: local accounts, no
payments, one SQLite file.

```
browser ── cookie ──► demo backend (this package, :9320) ── sig1 as `app`, actor app:<user> ──► engine (:8798)
   ▲                    │  accounts, credits, conversations                                      │
   └── SSE (relayed) ───┤  MCP server /api/mcp  ◄──── engine: inline runtime + sandbox agent ────┘
                        └  mint /api/engine/mcp-token ◄── engine (bearer APP_ENGINE_TOKEN)
```

## How it uses the engine

**The `app` principal.** The backend signs every engine call with `sig1` and the engine's
`SERVICE_AUTH_SECRET_APP` (`server/sig1.ts`, about thirty lines, tested against the engine's own
verifier), and names the user as the actor `app:<userId>`. The engine keeps one participant per
actor, so a session and its artifacts belong to that user. The browser never holds an engine
credential. Calls used: `POST /sessions`, `POST /sessions/:id/prompt`, `POST /sessions/:id/stop`,
`POST /sessions/:id/ws-token`, `GET /sessions/:id/messages`, `GET /sessions/:id/artifacts`,
`GET /sessions/:id/media/:artifactId` (`server/engine.ts`).

**Tools and persona over MCP.** The engine is configured with `APP_TOKEN_URL`, `APP_MCP_URL` and
`APP_ENGINE_TOKEN`. When a turn needs the product's tools it asks `POST /api/engine/mcp-token`
(bearer `APP_ENGINE_TOKEN`, body `{"user_id"}`) for a one-hour token for that user, then calls
`POST /api/mcp` with it (`server/mcp.ts`, Streamable HTTP with plain JSON answers). `initialize`
returns `instructions`: the persona "Pixel", including the rule to publish what it makes with
`upload-media` so it reaches the preview. The tools are `get_credit_balance`, `save_note`,
`list_notes` and `generate_image` (a mock generator that answers with a placeholder SVG); each sees
only the token's user. Both runtimes use them: the inline runtime as an MCP client, the sandbox's
Claude Code through its MCP configuration.

**Streaming.** The backend, not the browser, holds the engine WebSocket (`server/relay.ts`): it
subscribes with a ws-token minted as the user and relays `sandbox_event` (`token` carries the whole
reply so far, `tool_call`, `execution_complete`, ...) and `artifact_created` to the browser over
server-sent events. So the browser cannot send prompts around the credit check, and the backend sees
every turn end itself.

**Preview.** What the agent publishes with `upload-media` becomes a session artifact (`page` for
HTML, `file`, `screenshot`, `video`). The backend lists them and streams their bytes through, signed
as the user. A page is served with `Content-Security-Policy: sandbox allow-scripts ...`, so it runs
in an opaque origin, away from this app and its cookies.

**Credits.** A new account gets `DEMO_SIGNUP_CREDITS` (2,000; one credit is a tenth of a US cent). A
turn costs what the engine says it cost: the session's message list carries each turn's `costUsd`
(the highest cumulative cost its runtime reported) and its `runtime`. The backend settles a turn
once the engine reports it ended, rounding up to whole credits, when the relay sees
`execution_complete`, and again whenever the balance is read or a prompt is sent, so a turn missed
while the backend was down is still charged. A prompt is refused (HTTP 402) at zero credits or
below. A user runs one turn at a time, so a turn can take the balance below zero only once. A tool
the product charges for itself takes its price when it runs: `generate_image` costs 20 credits an
image and is refused, with nothing taken, when the balance is short. The engine never sees product
credits; it reports model cost, and the product prices its own tools.

**Inline or sandbox.** The engine decides per prompt (Jev): a conversational prompt runs inline in
the control plane; one that needs a computer starts a sandbox, and the inline model can escalate
with `use_sandbox`. The UI says which ran each turn ("Answered directly" or "Ran on a computer").

## One model

Both runtimes use **Claude Sonnet 4.6**: sessions are created with `anthropic/claude-sonnet-4-6`
(the engine's default sandbox model), and the local engine's inline runtime uses
`INLINE_MODEL=anthropic/claude-sonnet-4.6`, the same model by its OpenRouter id. Override with
`DEMO_MODEL`.

## Run it

Everything runs on this machine; see the root README for the engine's local stack (object store,
Docker data plane). In the engine's `.env.local`, name the demo as the product and give both sides
the same two secrets (any fresh random values):

```bash
SERVICE_AUTH_SECRET_APP=<random hex>     # the demo signs with it
APP_ENGINE_TOKEN=<random hex>            # the engine shows it when it asks for MCP tokens
APP_MCP_URL=http://localhost:9320/api/mcp
APP_TOKEN_URL=http://localhost:9320/api/engine/mcp-token
```

Then, each in its own terminal:

```bash
scripts/local/control-plane.sh   # the engine on WORKER_URL
scripts/local/demo-app.sh        # builds the web app and serves it with the backend on :9320
```

and open http://localhost:9320. (`scripts/local/env.sh` writes the four variables above for you;
`scripts/local/stack.sh up` starts everything, and `npm run e2e:local` and `npm run e2e:ui` drive
this app end to end: [docs/LOCAL_E2E.md](../../docs/LOCAL_E2E.md).) `scripts/local/demo-app.sh`
reads the same `.env.local` (the model key is never passed to the demo). A local sandbox reaches the
MCP server on the host's loopback through the Docker data plane's address rewriting.

| Variable                                      | Default                             | Meaning                                      |
| --------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| `SERVICE_AUTH_SECRET_APP`                     | required                            | sig1 key, the same value as the engine's     |
| `APP_ENGINE_TOKEN`                            | required                            | bearer the engine sends to the mint endpoint |
| `DEMO_ENGINE_URL`                             | `WORKER_URL`, else `:8797`          | the engine                                   |
| `DEMO_PORT`                                   | `9320`                              | where the demo listens (127.0.0.1)           |
| `DEMO_DATA_DIR`                               | `packages/demo-app/.local/demo-app` | the SQLite file (ignored by git)             |
| `DEMO_MODEL`                                  | `anthropic/claude-sonnet-4-6`       | model of the sessions it creates             |
| `DEMO_SIGNUP_CREDITS`, `DEMO_CREDITS_PER_USD` | `2000`, `1000`                      | credits for a new account, credits per USD   |

For UI work, `npm run dev:server -w @open-inspect/demo-app` and `npm run dev:web -w ...` run the
backend with reload and Vite on :5180, which proxies `/api`.

## Code

| Path                     | What it is                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| `server/app.ts`          | HTTP API: accounts, conversations, prompts, events, preview, mint, MCP         |
| `server/engine.ts`       | the engine client, signed as `app`                                             |
| `server/sig1.ts`         | the request signature                                                          |
| `server/relay.ts`        | the engine WebSocket, relayed to the browser                                   |
| `server/credits.ts`      | settling turns from the engine's reported cost                                 |
| `server/mcp.ts`          | the MCP server: persona and tools                                              |
| `server/store.ts`        | SQLite: users, sign-in and MCP tokens (hashed), conversations, turns, notes    |
| `web/`                   | React: sign-in, the app shell (`AppShell.tsx`: chat list, chat, preview, Me)   |
| `web/ui/`, `web/design/` | The design system: components, tokens, theme, showcase, rules test (DESIGN.md) |

The look: monochrome zinc, pills and large radii, flat, light and dark. The web app is built from a
small component library (`web/ui/`) and design tokens (`web/design/`), with the rules enforced by a
test; see [DESIGN.md](DESIGN.md). On a phone every page is a screen with a bottom tab bar; on a
desktop an icon rail, the chat list, the chat and the preview sit side by side. The preview has one
tab per artifact, and steps are plain-words lines instead of tool names.

`npm test -w @open-inspect/demo-app` runs the backend's tests against an in-memory engine: accounts,
the app signature, credit settlement and refusal, the mint endpoint, the MCP server and the
preview's headers.
