# Dedicated gateway foundation

[foundation.bicep](foundation.bicep) creates gateway-owned resources in its target
resource group. Deploy it into a new dedicated group, using new globally unique
names. It neither declares nor updates existing database servers, App Service
plans, VNets, or subnets.

| Resource           | Configuration                                        | Access                            |
| ------------------ | ---------------------------------------------------- | --------------------------------- |
| PostgreSQL         | Version 16, Standard_B1ms, 32 GiB                    | Private endpoint only             |
| Gateway database   | `llm_gateway`                                        | Separate owner and runtime logins |
| Container registry | Basic, admin and anonymous access disabled           | Authenticated HTTPS               |
| Key Vault          | Standard, RBAC, 90-day soft delete, purge protection | RBAC-authorized HTTPS             |
| Wrapping key       | RSA 3072, wrap and unwrap only                       | Runtime identity, key scope       |
| Runtime identity   | Dedicated user-assigned identity                     | Own ACR pull and key wrapping     |

PostgreSQL has seven-day point-in-time backup retention, storage autogrow, no
geo-redundant backup, and no high availability. B1ms is a small burstable server;
verify regional/subscription availability and monitor connections, CPU credits,
storage, and latency before adding sustained load. Storage autogrow can increase
the bill and cannot shrink storage afterward.

The database starts with public access disabled and receives a private endpoint
in `privateEndpointSubnetId`. `postgresPrivateDnsZoneId` must reference an
existing `privatelink.postgres.database.azure.com` zone with working VNet links
or DNS forwarding. The zone group adds records for the new server. It does not
change existing server records, networking, or DNS links. This uses the
[PostgreSQL Private Link model](https://learn.microsoft.com/en-us/azure/postgresql/network/concepts-networking-private-link),
without a delegated database subnet or temporary public firewall rules.

Basic ACR and this vault use authenticated public HTTPS endpoints; they are not
private endpoints. Database and control-plane ingress remain private. The runtime
identity receives only [AcrPull](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#acrpull)
on this registry and [Key Vault Crypto Service Encryption User](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/security#key-vault-crypto-service-encryption-user)
on this key. It cannot read the stored database-owner secret. CI publishing,
deployment, and secret-reading permissions must be supplied separately.

## Secrets and database bootstrap

Supply approved initial values through secure parameters: `adminPassword`,
`runtimePassword`, and `sessionHmacSecret`. The template stores three secrets in
the new vault:

- `migration-database-url` uses the new server's owner login.
- `runtime-database-url` uses the separate `runtimeLogin`.
- `session-hmac` holds the shared gateway session secret.

Both connection strings target `llm_gateway`, URI-encode the login/password, and
require verified TLS. The default logins are `gateway_owner` and `gateway_runtime`.
The template creates only the owner login through server provisioning. The
runtime login must be created out-of-band; its stored URL is not usable yet.

Run the matching migrator image from CI with private database access and the
exact host/database pins. After migration, create the runtime login using its
already approved password and grant only connect, schema usage, table DML, and
required sequence permissions on the gateway database. Configure owner default
privileges for future migration-created tables. Do not give runtime a database,
schema, table, or migration ownership role. Verify it cannot create or drop a
table before starting either gateway app.

Resolve only `runtime-database-url` and `session-hmac` for the App Service module.
Keep the migration-owner URL confined to CI's migration/bootstrap job. Control
and data bearer keys are created later through gateway key management; this
template does not generate or preconfigure them.

Persist the initial secure parameter values outside the repository. Reapplying
with changed values changes credentials or HMAC state; do not generate fresh
values on each CI run. Retain the wrapping key and its old versions for existing
encrypted rows. Pass the nonsecret `keyUriWithVersion` output to the runtime and
do not substitute a versionless key URL. Purge protection cannot be disabled
once enabled.

## Optional App Service DNS zone

When the VNet already uses `privatelink.azurewebsites.net`, leave
`createAppServicePrivateDnsZone=false` and pass its ID as
`existingAppServicePrivateDnsZoneId`. If no such zone exists, explicitly set the
flag to `true`: the module creates the zone in the new gateway group and links
it to `virtualNetworkId`, with auto-registration disabled. Verify absence first;
a second zone of the same name cannot be linked to the same VNet. Additional
consumer VNets need their own approved DNS links or forwarding configuration.

The outputs contain IDs, hostnames, the database name, and the versioned key URI;
they contain no passwords, tokens, or connection strings.

Compile before deployment:

```sh
az bicep build --file deploy/azure/foundation.bicep --outfile /tmp/llm-gateway-foundation.json
```

Review what-if against the intended new resource group. The only attachments to
existing infrastructure are the new database private endpoint/DNS records and,
when requested, the new App Service zone's VNet link. After an approved deploy,
verify public database denial, private DNS/TLS, image authentication, role scope,
and runtime DML restrictions before deploying [the apps](app-service.md).
