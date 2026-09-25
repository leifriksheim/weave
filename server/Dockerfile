# The relay is two files and one dependency (`ws`, pinned in the lockfile), so
# the image is the runtime, that package and those files — plus coturn, which
# start.sh runs beside the relay when TURN_SECRET is set.
FROM node:22-alpine

RUN apk add --no-cache coturn

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY relay.mjs signaling-server.mjs start.sh turnserver.conf ./

ENV PORT=8080
EXPOSE 8080

# Runs as a non-root user that the base image already provides.
USER node

CMD ["./start.sh"]
