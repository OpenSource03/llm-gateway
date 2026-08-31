# Azure Container Apps reference

This Bicep module deploys the gateway roles into an existing Container Apps
environment:

- public data-plane app;
- internal-only control-plane app;
- no-ingress worker app;
- manually triggered migration job.

Create PostgreSQL Flexible Server, private DNS/networking, an immutable RSA Key
Vault key, and the least-privilege user-assigned identity separately. The
runtime database login must have DML only; pass the migration-owner URL only to
the migration job. Put the PostgreSQL TLS mode and certificate requirements in
that migration URL; `GATEWAY_DATABASE_SSL_MODE` configures the runtime adapter,
not Prisma's migration CLI.

Run `az deployment group what-if` before deploying. Start the migration job
after publishing a reviewed image and before shifting data-plane traffic.

An Agent SDK bridge may be deployed separately with private ingress. Set
`agentSdkUrl` and the secure `agentSdkApiKey` parameter to make it available;
accounts still use direct transport until linked through the control API. Keep
`agentSdkAllowInsecure=false` unless Container Apps networking or a service
mesh provides the compensating private trust boundary.
