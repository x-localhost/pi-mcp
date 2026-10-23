FROM node:24.22.0-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep fd-find ca-certificates \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force
COPY src ./src
COPY internal-agent ./internal-agent
RUN mkdir -p /workspace /var/lib/pi-mcp /var/lib/pi-mcp/home /run/pi-internal /etc/pi-internal \
    && touch /etc/pi-internal/config.json /etc/pi-internal/models.json /etc/pi-internal/gateway.json /etc/pi-internal/ca.pem \
    && chown -R 1000:1000 /workspace /var/lib/pi-mcp /run/pi-internal

ENV HOME=/var/lib/pi-mcp/home
USER 1000:1000
CMD ["node", "/app/internal-agent/agent-daemon.mjs"]
