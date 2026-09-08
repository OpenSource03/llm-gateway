# Azure deployment references

Use [app-service.bicep](app-service.bicep) for two Linux apps on an existing
App Service plan, with a private endpoint for control access. Its prerequisites
and rollout checks are in [app-service.md](app-service.md).

[foundation.bicep](foundation.bicep) creates a dedicated gateway PostgreSQL
server, database, registry, vault, wrapping key, and runtime identity in a new
resource group. Read [foundation.md](foundation.md) before its first deployment.

## Container Apps

This Bicep module deploys the gateway roles into an existing Container Apps
environment:

- public data-plane app;
- internal-only control-plane app;
- no-ingress worker app;
- manually triggered migration job.

Create PostgreSQL Flexible Server, private DNS/networking, an immutable RSA Key
Vault key, and the least-privilege user-assigned identity separately. The
runtime database login must have DML only: pass it as `databaseUrl`. Pass the
separate migration-owner URL as the secure `migrationDatabaseUrl` parameter;
only the migration job receives it. Both URLs must target the same dedicated
gateway database. Existing module callers must now supply both parameters.
Put the PostgreSQL TLS mode and certificate requirements in
that migration URL; `GATEWAY_DATABASE_SSL_MODE` configures the runtime adapter,
not Prisma's migration CLI.

Run `az deployment group what-if` before deploying. Start the migration job
after publishing a reviewed image and before shifting data-plane traffic.

An Agent SDK bridge may be deployed separately with private ingress. Set
`agentSdkUrl` and the secure `agentSdkApiKey` parameter to make it available;
accounts still use direct transport until linked through the control API. Keep
`agentSdkAllowInsecure=false` unless Container Apps networking or a service
mesh provides the compensating private trust boundary.
