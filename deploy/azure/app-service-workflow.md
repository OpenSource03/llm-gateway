# App Service release workflow

Run `Deploy Azure App Service` manually with a reviewed full commit SHA. The
`azure-production` GitHub environment holds the deployment variables and its
approval rules. The current release targets US production only; Israel and
staging remain disconnected. Its OIDC identity needs image push and metadata-update access
to the dedicated registry, read/start access to the migration job, and read/write
access to the two gateway apps. Grant no access to integrating applications.

Configure these environment variables:

| Variable                              | Value                                           |
| ------------------------------------- | ----------------------------------------------- |
| `AZURE_DEPLOY_CLIENT_ID`              | Dedicated deployment managed identity client ID |
| `AZURE_TENANT_ID`                     | Azure tenant ID                                 |
| `AZURE_SUBSCRIPTION_ID`               | Azure subscription ID                           |
| `GATEWAY_RESOURCE_GROUP`              | Dedicated group beginning `rg-llm-gateway-`     |
| `GATEWAY_ACR_NAME`                    | Registry name in that group                     |
| `GATEWAY_DATA_APP`                    | App name beginning `app-llm-gateway-data-`      |
| `GATEWAY_CONTROL_APP`                 | App name beginning `app-llm-gateway-control-`   |
| `GATEWAY_MIGRATION_JOB`               | Job name beginning `llm-gateway-migrate-`       |
| `GATEWAY_MIGRATION_EXPECTED_HOST`     | Dedicated PostgreSQL server hostname            |
| `GATEWAY_MIGRATION_EXPECTED_DATABASE` | Database name beginning `llm_gateway`           |

Federate the deployment identity to this repository's
`environment:azure-production` subject. The registry must allow the GitHub
runner's network path; images remain private and pulls require authentication.
The migration job must already hold its database-owner URL as a secret reference
and the two exact migration-target variables as literal environment values.
Environment names must be unique. Container command/argument overrides and init
containers must be absent or empty so the reviewed image runs its migration
command. Runtime apps use their separate DML-only database login.

For the first release, provision the foundation and dispatch with `deploy=false`.
CI publishes runtime and migrator images without requiring the job or apps to
exist. Use the resulting digests to provision and run the migration job; require
success before provisioning the apps. This avoids starting an app against an
empty schema.

Later dispatches use `deploy=true`. CI preserves the complete existing job
template, overrides only its container image for that execution, and waits for
successful migrations before updating either app image. The job's saved template
is unchanged. Runtime and migrator tags are full commit SHAs, locked against
overwrite and deletion; existing tags are reused. Apps receive digest references.
The existing tag-triggered release workflow is unchanged.

CI requires HTTP 200 from the public data app's `/health/ready`. An operator must
also verify private control readiness, bearer-key enforcement, and synthetic
inference from the intended networks. HTTP readiness alone does not verify which
container answered during an App Service warmup. Previous runtime references
are retained in the workflow summary; rollback needs review of migration
compatibility before selecting an older image.
