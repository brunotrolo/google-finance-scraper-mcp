FROM node:20-slim

# Install system Chromium + all shared-library dependencies.
# We use the Debian-packaged Chromium (/usr/bin/chromium) instead of
# Puppeteer's bundled download to keep Cloud Build fast and deterministic.
RUN apt-get update && apt-get install -y \
    chromium \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libdrm2 \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip its own ~300 MB Chromium download during npm install.
# PUPPETEER_EXECUTABLE_PATH is read by getBrowser() in src/index.ts.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["npm", "start"]
