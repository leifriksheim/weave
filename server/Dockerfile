# The relay is one file with no dependencies, so the image is the runtime plus
# that file. Nothing is installed, and there is nothing to keep up to date.
FROM node:22-alpine

WORKDIR /app
COPY signaling-server.mjs ./

ENV PORT=8080
EXPOSE 8080

# Runs as a non-root user that the base image already provides.
USER node

CMD ["node", "signaling-server.mjs"]
