# syntax=docker/dockerfile:1

# Container image for Google Cloud Run.
#
#   docker build -t document-generator .
#   docker run --rm -p 8080:8080 -e FIREBASE_PROJECT_ID=<project> document-generator
#
# Three stages keep the final image small: dependencies are installed, the app is built, and only
# Next.js's "standalone" output (a minimal server plus the node_modules files it actually uses)
# is copied into the image that runs. See docs/ARCHITECTURE.md, "Deployment".

# Node 24 is an active LTS line. Debian "slim" rather than Alpine: it uses glibc, so any native
# module a future dependency brings in will have prebuilt binaries.
#
# Docker Hub limits anonymous pulls, which shared build services run into. To pull the same
# official image through Google's mirror instead:
#   docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-slim .
ARG NODE_IMAGE=node:24-slim

# ── 1. Install dependencies (cached until package.json or the lockfile changes) ─────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ── 2. Build ─────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── 3. Run ───────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS run
WORKDIR /app

# Cloud Run sends requests to $PORT (8080 unless configured otherwise) and requires the server to
# listen on all interfaces. Next's standalone server reads both variables.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0

# The standalone server does not bundle static files; they sit next to it.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Run as the unprivileged user that the Node image provides.
USER node
EXPOSE 8080
CMD ["node", "server.js"]
