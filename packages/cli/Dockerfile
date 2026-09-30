# `weave host` as an image. Built from the repository root, because the CLI
# bundles the protocol and the relay from the workspace (packages/core,
# packages/relay):
#
#   docker build -f packages/cli/Dockerfile .
#
# (fly.toml next to this file does that for Fly.)

# The build: the CLI bundled to one file.
FROM node:22-alpine AS build
WORKDIR /repo
# The workspace's lockfile is only valid with every workspace's manifest in
# place, so all of them come first (and installs cache apart from source).
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/relay/package.json packages/relay/
COPY packages/cli/package.json packages/cli/
COPY apps/home/package.json apps/home/
COPY apps/example/package.json apps/example/
COPY apps/extension/package.json apps/extension/
RUN npm ci --ignore-scripts --workspace @weaveprotocol/cli
COPY packages/core packages/core
COPY packages/relay packages/relay
COPY packages/cli packages/cli
RUN npm run bundle -w @weaveprotocol/cli

# The runtime: Node, `ws` (the bundle's one outside dependency the host uses;
# node-datachannel is only for `weave connect`), and the bundle.
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY --from=build /repo/node_modules/ws node_modules/ws
COPY --from=build /repo/packages/cli/dist/weave.mjs dist/weave.mjs

ENV PORT=8080
ENV WEAVE_HOST_DATA=/data
EXPOSE 8080

# The data folder is a mounted volume, owned by root when it arrives, so the
# host starts as root only to hand it to the `node` user, then runs as that.
CMD ["sh", "-c", "mkdir -p \"$WEAVE_HOST_DATA\" && chown -R node:node \"$WEAVE_HOST_DATA\" && exec su-exec node node dist/weave.mjs host --host 0.0.0.0"]
