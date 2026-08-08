FROM node:22-slim

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

ENV SANDBOX_ISOLATION_REQUIRED="true"
ENV SANDBOX_EXEC_NETWORK_DEFAULT="true"
ENV SANDBOX_RUN_NETWORK_DEFAULT="true"
ENV SANDBOX_INSTALL_NETWORK_DEFAULT="true"
ENV GIT_NETWORK_DEFAULT="true"

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["node", "--import", "tsx", "src/index.ts"]
