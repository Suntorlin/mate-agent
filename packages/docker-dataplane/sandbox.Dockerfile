# syntax=docker/dockerfile:1
#
# A slim sandbox image for the local Docker data plane: the sandbox runtime, the Claude Agent
# SDK (whose wheel bundles the `claude` binary), OpenCode, Node and the basic shell tools, built natively
# for the host's architecture. The full image (packages/sandbox-images) pins amd64-only tools and
# does not build under emulation on Apple silicon; this one is for local development only.
#
# Build with the runtime package as the context:
#   docker build -f packages/docker-dataplane/sandbox.Dockerfile -t agent-engine-sandbox:local \
#     packages/sandbox-runtime

FROM node:24-bookworm-slim AS node

FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq procps ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# OpenCode, the harness for OpenAI, xAI and the other non-Anthropic models, and the plugin
# package its plugins and tools import, where the full image puts it (~/.config/opencode).
# Keep the version in step with "opencode" in packages/sandbox-images/toolchain.json.
ARG OPENCODE_VERSION=1.18.29
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && mkdir -p /root/.config/opencode \
    && cd /root/.config/opencode \
    && npm install --no-audit --no-fund "@opencode-ai/plugin@${OPENCODE_VERSION}" \
    && opencode --version

# The runtime's launch paths match the full image's (runtimeEnv in packages/sandbox-images):
# the interpreter under /opt/openinspect/python, the package importable from /app.
RUN python -m venv /opt/openinspect/python
COPY pyproject.toml /tmp/runtime/pyproject.toml
COPY src /tmp/runtime/src
RUN --mount=type=cache,target=/root/.cache/pip \
    /opt/openinspect/python/bin/pip install /tmp/runtime \
    && mkdir -p /app /workspace \
    && ln -s "$(/opt/openinspect/python/bin/python -c 'import sandbox_runtime; print(sandbox_runtime.__path__[0])')" /app/sandbox_runtime \
    && rm -rf /tmp/runtime

ENV HOME=/root PYTHONPATH=/app PATH=/opt/openinspect/python/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /workspace
CMD ["python", "-m", "sandbox_runtime.entrypoint"]
