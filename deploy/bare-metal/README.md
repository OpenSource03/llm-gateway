# Bare-metal deployment

1. Install Docker Engine, Compose, and Caddy (or another TLS reverse proxy).
2. Place this repository at `/opt/llm-gateway`.
3. Create a dedicated unprivileged host user for the gateway and an
   `/etc/llm-gateway` directory. Put the RSA key there with mode `0600`, owned
   by that user. Copy `llm-gateway.env.example` to `llm-gateway.env`, replace
   every placeholder, set `GATEWAY_UID`/`GATEWAY_GID` to that owner's numeric
   IDs, and keep the environment file root-only. Keep all values stable across
   restarts.
4. Keep port 8081 bound to loopback. Expose only the data-plane port through
   the TLS reverse proxy.
5. Install `llm-gateway.service`, start it, then create the first control key:

   ```bash
   docker compose -f deploy/compose/compose.yml run --rm gateway \
     node dist/cli.js control-keys create \
     --name local-admin --owner "Local operator"
   ```

Back up PostgreSQL and the RSA key separately. Losing the RSA key makes stored
provider credentials unrecoverable.
