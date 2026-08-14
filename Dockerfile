# Krix Enterprise Model Context Protocol (MCP) Multi-Runtime Gateway
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000

# Install multi-runtime compilers and tools for isolated sandboxes:
# Python3 + pip, Go, Java (OpenJDK 17), G++ / GCC (build-essential), Git, Bash, and curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    golang-go \
    openjdk-17-jre-headless \
    g++ \
    gcc \
    make \
    git \
    bash \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for Docker layer caching
COPY package.json tsconfig.json ./

# Install npm dependencies
RUN npm install --omit=dev && npm install -g tsx

# Copy application source, public assets, and configurations
COPY config ./config
COPY public ./public
COPY src ./src
COPY policy.md README.md ./

# Create non-root system user for runtime isolation
RUN groupadd -r krixgroup && useradd -r -g krixgroup -m -d /home/krixuser krixuser \
    && chown -R krixuser:krixgroup /app /tmp

USER krixuser

# Expose port (Render automatically maps this to 10000 or $PORT)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Start the Krix MCP Gateway
CMD ["npx", "tsx", "src/index.ts"]
