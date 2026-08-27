# =============================================================================
# World Monitor — Docker Image
# =============================================================================
# Multi-stage build:
#   builder       — installs deps, compiles runtime handlers, builds frontend
#   runtime-deps  — installs only packages needed by runtime handler helpers
#   final         — nginx (static) + node (API) under supervisord
# =============================================================================

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

WORKDIR /app

# Install root dependencies (layer-cached until package.json changes)
# Override NODE_ENV so devDependencies are included — they're required by the
# build scripts (tsx, vite, tsc, etc.) even when Coolify sets NODE_ENV=production.
COPY package.json package-lock.json ./
RUN NODE_ENV=development npm ci --ignore-scripts

# Copy full source
COPY . .

# Build a complete runtime API tree under build/api without modifying source.
# build-handlers also mirrors that compiled tree under api/.runtime-scan: the
# existing attribution walker recursively scans api/, while docs-stats ignores
# dot-prefixed top-level API entries and continues parsing pristine source files.
RUN node docker/build-handlers.mjs

# Regenerate source attribution while both pristine source and the hidden
# compiled-bundle mirror are visible. This preserves the previous requirement
# that URLs introduced by bundling are part of attribution evidence.
RUN node scripts/source-attribution.mjs --write

# Generate inventory facts from pristine source and the freshly-written
# attribution ledger, then place the runtime-generated module beside the
# compiled product-catalog handler that imports it.
RUN node scripts/generate-inventory-facts.mjs && \
    cp api/_inventory-facts.generated.js build/api/_inventory-facts.generated.js

# Build crawlable/content artifacts while the attribution mirror is still
# present, then remove that build-only mirror before TypeScript/Vite compilation.
# Skip blog build — blog-site has its own deps not installed here.
RUN npm run build:crawlable-corpus && \
    npm run build:content-corpus && \
    rm -rf api/.runtime-scan && \
    npx tsc && \
    npx vite build

# ── Stage 2: Runtime dependencies ───────────────────────────────────────────
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime-deps

WORKDIR /app

# Keep the runtime dependency set deliberately smaller than the app's full
# production graph. Runtime helper modules copied into build/api can still
# contain package imports even though handler entrypoints themselves are bundled.
COPY docker/runtime-package.json ./package.json
COPY docker/runtime-package-lock.json ./package-lock.json
RUN npm ci --omit=dev --omit=optional --ignore-scripts

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS final

# nginx + supervisord
RUN apk add --no-cache nginx supervisor gettext && \
    mkdir -p /tmp/nginx-client-body /tmp/nginx-proxy /tmp/nginx-fastcgi \
             /tmp/nginx-uwsgi /tmp/nginx-scgi /var/log/supervisor && \
    addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# API server
COPY --from=builder /app/src-tauri/sidecar/local-api-server.mjs ./local-api-server.mjs
COPY --from=builder /app/src-tauri/sidecar/package.json ./package.json

# Minimal runtime node_modules required by unbundled helper modules in the
# isolated runtime API tree.
COPY --from=runtime-deps /app/node_modules ./node_modules

# API runtime tree: pristine helper/assets copy plus compiled handler overlays.
COPY --from=builder /app/build/api ./api

# Static data files used by handlers at runtime
COPY --from=builder /app/data ./data

# Built frontend static files
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx + supervisord configs
COPY docker/nginx.conf /etc/nginx/nginx.conf.template
COPY docker/supervisord.conf /etc/supervisor/conf.d/worldmonitor.conf
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Ensure writable dirs for non-root
RUN chown -R appuser:appgroup /app /tmp/nginx-client-body /tmp/nginx-proxy \
    /tmp/nginx-fastcgi /tmp/nginx-uwsgi /tmp/nginx-scgi /var/log/supervisor \
    /var/lib/nginx /var/log/nginx

USER appuser

EXPOSE 8080

# Healthcheck via nginx. Use 127.0.0.1 (not localhost - that resolves to ::1
# first, where nginx does not listen). Probe /api/sidecar-health, a dedicated
# auth-exempt liveness route in the sidecar (local-api-server.mjs): reaching it
# through nginx's /api/ proxy verifies BOTH nginx and the node sidecar are up,
# unlike a static "/" probe which only proves nginx is serving. Keep this off
# /api/health so the public compact data-health contract still reaches api/health.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/sidecar-health >/dev/null 2>&1 || exit 1

CMD ["/app/entrypoint.sh"]
