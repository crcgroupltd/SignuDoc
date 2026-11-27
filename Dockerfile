# SignuDoc, built into a self-contained Next.js server.
# docker-compose.yml builds and runs this next to Postgres.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# The commit the image was built from, shown in Settings. The image workflow
# passes it; a local build leaves it empty.
ARG SIGNUDOC_COMMIT=""
ENV SIGNUDOC_COMMIT=${SIGNUDOC_COMMIT}
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DRIVER=local \
    STORAGE_LOCAL_DIR=/data/storage

# The server and the dependencies it was traced to need.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Read from disk at run time, relative to the working directory
# (src/lib/services/pdf-fonts.ts), so they are copied in explicitly.
COPY --from=build --chown=node:node /app/src/assets/fonts ./src/assets/fonts
COPY --from=build --chown=node:node /app/node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm ./node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm

# The migration runner, applied on every start by the entrypoint.
COPY --from=build --chown=node:node /app/db ./db
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data/storage \
 && chown -R node:node /data

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
