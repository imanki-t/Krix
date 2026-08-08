FROM node:22.22.2-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    golang-go \
    default-jdk-headless \
    g++ \
    rustc \
    ruby \
    php-cli \
    curl \
    ca-certificates \
    bubblewrap \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Run the gateway as an unprivileged user. Bubblewrap provides the second
# isolation boundary for sandboxed workloads.
RUN useradd --system --create-home --uid 10001 krix
ENV NODE_ENV=production
ENV SANDBOX_ISOLATION_REQUIRED="true"
ENV SANDBOX_EXEC_NETWORK_DEFAULT="false"
ENV SANDBOX_RUN_NETWORK_DEFAULT="false"
ENV SANDBOX_INSTALL_NETWORK_DEFAULT="false"
ENV GIT_NETWORK_DEFAULT="false"

COPY package*.json ./
RUN npm ci

COPY . .
RUN chown -R krix:krix /app
USER krix

EXPOSE 3000

CMD ["node", "--import", "tsx", "src/index.ts"]
