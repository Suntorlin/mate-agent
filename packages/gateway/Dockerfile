# The gateway's Node host, built from the repository root (the workspace lockfile is there):
#   docker build -f packages/gateway/Dockerfile -t gateway:local .
# The first stage installs the gateway's dependencies from the lockfile (install scripts off) and
# bundles src/node/main.ts; the image itself holds that one file and Node.
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/gateway/package.json packages/gateway/
RUN npm ci --workspace @open-inspect/gateway --include-workspace-root=false \
  --ignore-scripts --no-audit --no-fund
COPY packages/gateway/src packages/gateway/src
RUN npm run build:node --workspace @open-inspect/gateway

FROM node:24-alpine
WORKDIR /app
COPY --from=build /repo/packages/gateway/dist/node/main.js ./main.js
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8790 DATA_DIR=/data
EXPOSE 8790
CMD ["node", "main.js"]
