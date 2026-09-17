FROM node:22-bookworm-slim AS installer

ARG MERIDIAN_VERSION=1.71.1

RUN npm install --global --omit=dev --no-audit --no-fund "@rynfar/meridian@${MERIDIAN_VERSION}" && \
    node -e "const p=require('/usr/local/lib/node_modules/@rynfar/meridian/package.json');if(p.version!=='${MERIDIAN_VERSION}'||p.license!=='MIT')process.exit(1)"

COPY deploy/agent-sdk/patches/preserve-cancelled-checkpoint.mjs /tmp/
COPY deploy/agent-sdk/patches/token-profiles.mjs /tmp/
COPY deploy/agent-sdk/patches/session-diagnostics*.mjs /tmp/
COPY deploy/agent-sdk/patches/upstream-rewrite.mjs /usr/local/lib/node_modules/@rynfar/meridian/dist/gateway-upstream-rewrite.mjs
COPY deploy/agent-sdk/patches/bridge-entry.mjs /usr/local/lib/node_modules/@rynfar/meridian/dist/gateway-bridge-entry.mjs
RUN node /tmp/preserve-cancelled-checkpoint.mjs \
      /usr/local/lib/node_modules/@rynfar/meridian/dist && \
    node /tmp/token-profiles.mjs /usr/local/lib/node_modules/@rynfar/meridian/dist && \
    node /tmp/session-diagnostics.mjs /usr/local/lib/node_modules/@rynfar/meridian/dist && \
    rm /tmp/preserve-cancelled-checkpoint.mjs /tmp/token-profiles.mjs /tmp/session-diagnostics*.mjs

FROM node:22-bookworm-slim AS runtime

RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends ca-certificates dumb-init && \
    rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx && \
    printf '%s\n' '6c6c6d676174657761796167656e7473' > /etc/machine-id && \
    mkdir -p /home/node/.claude /home/node/.config/meridian /home/node/.cache /home/node/.local/share && \
    chown -R node:node /home/node

COPY --from=installer --chown=node:node \
  /usr/local/lib/node_modules/@rynfar/meridian /opt/meridian

ENV NODE_ENV=production \
    HOME=/home/node \
    MERIDIAN_HOST=0.0.0.0 \
    MERIDIAN_PORT=3456 \
    MERIDIAN_PASSTHROUGH=1 \
    MERIDIAN_SUPPRESS_SCRATCHPAD=1

USER node
WORKDIR /opt/meridian
EXPOSE 3456

HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "const r=await fetch('http://127.0.0.1:3456/health');process.exit(r.ok?0:1)"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "/opt/meridian/dist/gateway-bridge-entry.mjs"]
