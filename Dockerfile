# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 python3-pip golang-go default-jdk-headless g++ rustc ruby php-cli curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap git python3 python3-pip golang-go default-jdk-headless g++ rustc ruby php-cli ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 krix \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/krix --create-home --shell /usr/sbin/nologin krix

WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=400"
ENV SANDBOX_MODE=bwrap

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY assets ./assets
COPY skills ./skills

RUN mkdir -p /tmp/krix /home/krix && chown -R krix:krix /app /tmp/krix /home/krix && chmod 0755 /app
USER krix

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
