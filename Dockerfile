FROM node:22-slim

# Install OS-level deps needed by src/sandboxTools.ts (git clone/commit/push,
# and every language fileRunCmd() supports: py/js/ts/sh/go/java/cpp).
# Single stage on purpose — everything installed here stays in the final
# image, unlike a multi-stage build that only copies specific paths
# (e.g. node_modules) into a separate runtime stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    golang-go \
    default-jdk-headless \
    g++ \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Render's free tier caps the container at 512MB. Node's default heap limit
# scales with available memory and can grow well past that, so tsc (and the
# app itself at runtime) can get OOM-killed before V8 ever triggers its own
# GC-based backoff. Capping the heap at 400MB leaves ~100MB of headroom for
# stack space, native buffers, and other non-heap overhead.
ENV NODE_OPTIONS="--max-old-space-size=400"

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Render sets PORT via env; index.ts already reads process.env.PORT || 3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
