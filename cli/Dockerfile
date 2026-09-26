# `weave host` as an image. Built from the repository root, because the CLI
# bundles the protocol from ../src:
#
#   docker build -f cli/Dockerfile .
#
# (fly.toml next to this file does that for Fly.)

# The build: the CLI bundled to one file, and the pay page's WalletConnect
# bundle next to it, where the host looks for it (../pay/dist from dist/).
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.json ./
COPY cli/package.json cli/
RUN npm ci --ignore-scripts
COPY src src
COPY cli cli
RUN npm run bundle -w cli && npm run bundle:pay -w cli

# The runtime: Node, `ws` (the bundle's one outside dependency the host uses;
# node-datachannel is only for `weave connect`), and the two bundles.
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY --from=build /repo/node_modules/ws node_modules/ws
COPY --from=build /repo/cli/dist/weave.mjs dist/weave.mjs
COPY --from=build /repo/cli/pay/dist/walletconnect.js pay/dist/walletconnect.js

ENV PORT=8080
ENV WEAVE_HOST_DATA=/data
EXPOSE 8080

# The data folder is a mounted volume, owned by root when it arrives, so the
# host starts as root only to hand it to the `node` user, then runs as that.
CMD ["sh", "-c", "mkdir -p \"$WEAVE_HOST_DATA\" && chown -R node:node \"$WEAVE_HOST_DATA\" && exec su-exec node node dist/weave.mjs host --host 0.0.0.0"]
