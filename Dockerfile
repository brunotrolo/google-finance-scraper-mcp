# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
# Install ALL deps (including devDeps) for TypeScript compilation
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:20-slim

# Install Chromium and its runtime dependencies.
# node:20-slim is Debian Bookworm slim — Chromium lives at /usr/bin/chromium.
# These packages satisfy Chromium's shared-library requirements in a minimal
# container (the full list is pruned with --no-install-recommends).
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Skip Puppeteer's own Chromium download — we use the system one above.
# PUPPETEER_EXECUTABLE_PATH is read by src/index.ts at launch time.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
# Production-only install — no devDeps, no Chromium download
RUN npm ci --omit=dev

COPY --from=builder /app/build ./build

EXPOSE 8080
CMD ["node", "build/index.js"]
