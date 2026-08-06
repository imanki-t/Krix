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

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Render sets PORT via env; index.ts already reads process.env.PORT || 3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
