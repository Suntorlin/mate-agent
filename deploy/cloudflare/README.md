# Cloudflare configs (templates)

`wrangler.staging.jsonc` and `gateway.staging.jsonc` describe how the engine and the LLM gateway are
laid out on Cloudflare (Durable Objects, D1, R2, queues, crons). They are templates: every id is a
placeholder and no account is named. The integration tests and `configs.test.mjs` read them.

This repository has no Cloudflare environment. Do not deploy from it; see AGENTS.md, "Red lines".
Creating one (its own account, names, ids and secrets) is a separate, explicit step.
