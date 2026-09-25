# The relay is two files and one dependency (`ws`, pinned in the lockfile), so
# the image is the runtime, that package and those files.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY relay.mjs signaling-server.mjs ./

ENV PORT=8080
EXPOSE 8080

# Runs as a non-root user that the base image already provides.
USER node

CMD ["node", "signaling-server.mjs"]
