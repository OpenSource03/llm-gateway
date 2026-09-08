# App Service deployment

[app-service.bicep](app-service.bicep) adds two Linux container apps to an
existing plan. Both use the same dedicated gateway database and wrapping key.

```text
Public clients -> Data app :8080 -> Gateway PostgreSQL
                  role=all           ^
                  scheduler          |
                  control=loopback   |
                                     |
Private BFF -> Private endpoint -> Control app :8081
                                  role=control

CI migration job -----------------> same database, separate owner login
```

The data app runs the scheduler; PostgreSQL leases coordinate its jobs across
replicas. Its control listener binds only to `127.0.0.1:8081`. App Service routes
public HTTP traffic to port 8080. The separate control app exposes port 8081
through its private endpoint and disables public network access. Control bearer
keys and scopes remain required on private requests.

## Existing resources and permissions

- Supply a Linux App Service plan in the app region with Always On, regional
  VNet integration, and private-endpoint support. Check spare CPU, memory, and
  subnet capacity before adding the apps to a shared plan.
- Supply an integration subnet delegated to `Microsoft.Web/serverFarms` and a
  separate private-endpoint subnet. The module does not change either subnet.
- Supply the `privatelink.azurewebsites.net` zone. Link it, or its DNS resolver,
  to every VNet that needs control access. Peering alone does not configure DNS.
- Create a dedicated gateway user-assigned identity. Grant it image-pull access
  to the existing ACR and wrapping/unwrapping access to the pinned Key Vault RSA
  key. Supply both its resource ID and client ID. The module attaches the identity
  but does not create identities or role assignments.
- Supply a dedicated PostgreSQL database with a DML-only runtime login. Both
  apps receive `runtimeDatabaseUrl`; neither receives migration credentials.
  Give the runtime role access to new migration-created tables through owner
  default privileges or an explicit post-migration grant step.

The registry hostname must match `image`. Use a reviewed immutable digest or
commit tag from CI. `vnetImagePullEnabled` enables VNet image pulls for a
network-protected registry; its private DNS and routes must already work.
Application internet egress stays on the normal App Service path unless
`vnetRouteAllEnabled` is enabled. The configured path must reach provider HTTPS
endpoints, PostgreSQL, Key Vault, and Azure identity services.
These parameters map to the current `outboundVnetRouting.imagePullTraffic` and
`applicationTraffic` site properties. See [VNet routing](https://learn.microsoft.com/en-us/azure/app-service/configure-vnet-integration-routing).

Use the control app's ordinary HTTPS hostname from `controlBaseUrl`, resolving
to the private endpoint. Do not use its private IP as the URL: TLS requires the
hostname. The endpoint and DNS zone group are created here; VNet links, custom
domains, edge proxies, certificates, databases, and the plan are managed outside
this module. App Service and [private-endpoint networking](https://learn.microsoft.com/en-us/azure/app-service/overview-private-endpoint)
use separate inbound and outbound paths.

## Deploy through CI

1. Build and publish matching runtime and migrator images through CI. Confirm
   image-pull and wrapping-key permissions before the apps start.
2. Run the migrator image in a separate CI job with private database access.
   Set `GATEWAY_DATABASE_URL` to its owner login and set
   `GATEWAY_MIGRATION_EXPECTED_HOST` and
   `GATEWAY_MIGRATION_EXPECTED_DATABASE` to the exact target. Include PostgreSQL
   TLS settings in that URL. Require successful migrations before applying the
   app module or changing its runtime image.
3. Review the deployment what-if, then deploy the module with secret parameters
   supplied by the deployment secret store. Never commit populated parameter
   files. The module owns both apps' app settings; keep subsequent settings in
   its source so a later deployment cannot silently remove them.
4. Verify `/health/ready` returns 200 on both apps from their intended networks.
   Confirm the public data hostname cannot serve `/admin/v1/status`, the control
   hostname rejects public access, and private control requests enforce bearer
   authentication and scopes.
5. Exercise synthetic inference and a multi-turn tool loop through each enabled
   public protocol. Keep the prior image reference for rollback. Image replacement
   can interrupt existing streams; clients need reconnect/retry handling.

Startup runs the runtime image's normal entrypoint, with no migrations. Warmup
requires readiness HTTP 200. Basic FTP/SCM publishing credentials are disabled;
the public data app's SCM ingress is denied. Deployment uses ARM image updates,
not SCM uploads. The module follows Microsoft's [container configuration](https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container)
and [site resource schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.web/2024-11-01/sites).

The optional SDK URL must be HTTPS and privately reachable. Supplying it does
not deploy a bridge or change account transports. Keep its dedicated service key
in the secret store and retain the existing [redistribution boundary](../../THIRD_PARTY_NOTICES.md).

Compile locally:

```sh
az bicep build --file deploy/azure/app-service.bicep --outfile /tmp/llm-gateway-app-service.json
```

Compilation checks the template; live permissions, DNS, image pulls, migrations,
and inference still need the deployment checks above.
