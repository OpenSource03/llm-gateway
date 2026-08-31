# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@8.15.4 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/admin-client/package.json packages/admin-client/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

FROM dependencies AS builder
COPY . .
RUN pnpm prisma:generate && pnpm build
RUN pnpm --filter @opensource03/llm-gateway-server deploy --prod /opt/llm-gateway

FROM builder AS migrator
ENV NODE_ENV=production
WORKDIR /workspace/apps/gateway
RUN rm -rf \
      /root/.cache \
      /root/.local \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack && \
    rm -f \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.config.ts"]

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init ca-certificates && \
    rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /opt/llm-gateway ./
USER node
EXPOSE 8080 8081
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
