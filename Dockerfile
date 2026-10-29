FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Fork (2026-10-29): keep only what the server loads (see scripts/prune-runtime.mjs);
# client-only packages are already bundled into dist/client. ~516 MB -> ~200 MB.
COPY --from=builder /app/dist/runtime-packages.json /app/scripts/prune-runtime.mjs /tmp/
RUN node /tmp/prune-runtime.mjs /app /tmp/runtime-packages.json && rm /tmp/prune-runtime.mjs /tmp/runtime-packages.json

# Fork (2026-10-29): demos are verified in Chrome for Testing's headless shell
# (321 MB with its libraries) instead of Debian's full chromium (716 MB). Both
# passed the same demo checks: canvas/slider/rAF, a thrown error, a
# failed CDN load, a probe and an SVG screenshot. Pinned like the Claude CLI.
# This image is amd64-only: Chrome for Testing does not publish a
# linux-arm64 headless shell. Bump the SHA-256 with the version.
FROM node:22-bookworm-slim AS browser
ARG TARGETARCH
ARG CHROME_HEADLESS_SHELL_VERSION=156.0.8078.73
ARG CHROME_HEADLESS_SHELL_SHA256=77eb8d52798efc7a857ab61abcc62a456d8ea9635b02341d06dffee2761768c8
RUN test "${TARGETARCH:-amd64}" = amd64 || { echo "chrome-headless-shell has no linux-arm64 build; this image is amd64-only" >&2; exit 1; } \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_HEADLESS_SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip" -o /tmp/shell.zip \
    && echo "${CHROME_HEADLESS_SHELL_SHA256}  /tmp/shell.zip" | sha256sum -c - \
    && unzip -q /tmp/shell.zip -d /opt && rm /tmp/shell.zip

FROM node:22-bookworm-slim
# Fork port (2026-10-29): the Claude Code provider runs the real `claude -p`
# instead of pi-ai's Claude OAuth (which impersonated Claude Code). Pinned so a
# rebuild never changes the CLI behind the bridge; the self-updater stays off.
# Auth is CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in runtime.env;
# CLAUDE_CONFIG_DIR is a mounted writable dir because the CLI writes its state.
ARG CLAUDE_CODE_VERSION=2.1.312
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
# The headless shell's shared libraries (found with ldd), CA roots for demo CDN
# scripts, and DejaVu, which resvg draws figure text with (chromium pulled it in).
# fontconfig-config ships /etc/fonts/fonts.conf; without it resvg finds no system
# fonts and figure text renders blank.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core fontconfig-config \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libx11-6 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libexpat1 libxcb1 libxkbcommon0 libasound2 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=browser /opt/chrome-headless-shell-linux64 /opt/chrome-headless-shell-linux64
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=/claude CHROME_PATH=/opt/chrome-headless-shell-linux64/chrome-headless-shell
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/dist/runtime/ ./
RUN mkdir -p /data /claude && chown node:node /data /claude
EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
