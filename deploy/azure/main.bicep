targetScope = 'resourceGroup'

@description('Resource-name prefix.')
param namePrefix string = 'llm-gateway'

param location string = resourceGroup().location

@description('Existing Azure Container Apps managed environment resource ID.')
param containerAppsEnvironmentId string

@description('User-assigned managed identity resource ID used for Key Vault cryptography.')
param managedIdentityResourceId string

@description('Client ID of the user-assigned managed identity.')
param managedIdentityClientId string

@description('Runtime OCI image.')
param image string = 'ghcr.io/opensource03/llm-gateway:v0.1.0'

@description('Migration OCI image.')
param migratorImage string = 'ghcr.io/opensource03/llm-gateway-migrator:v0.1.0'

@secure()
@description('DML-only runtime connection string for the gateway database.')
param databaseUrl string

@secure()
@description('Migration-owner connection string, supplied only to the migration job.')
param migrationDatabaseUrl string

@secure()
param sessionHmacSecret string

@description('Immutable Azure Key Vault RSA key version URL.')
param keyVaultKeyId string

@description('Optional private Claude Agent SDK bridge origin.')
param agentSdkUrl string = ''

@secure()
@description('API key for the optional private Claude Agent SDK bridge.')
param agentSdkApiKey string = ''

@description('Allow plain HTTP only when the bridge is protected by an isolated private network.')
param agentSdkAllowInsecure bool = false

@description('Bounded JSON array of corrections for stale external bridge catalog rows.')
param agentSdkModelRewritesJson string = '[]'

param publicBaseUrl string
param migrationExpectedHost string
param migrationExpectedDatabase string

var commonSecrets = concat([
  {
    name: 'database-url'
    value: databaseUrl
  }
  {
    name: 'session-hmac'
    value: sessionHmacSecret
  }
], empty(agentSdkUrl) ? [] : [
  {
    name: 'agent-sdk-api-key'
    value: agentSdkApiKey
  }
])

var commonEnv = concat([
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'GATEWAY_DATABASE_URL'
    secretRef: 'database-url'
  }
  {
    name: 'GATEWAY_DATABASE_SSL_MODE'
    value: 'verify-full'
  }
  {
    name: 'GATEWAY_SESSION_HMAC_SECRET'
    secretRef: 'session-hmac'
  }
  {
    name: 'GATEWAY_PUBLIC_URL'
    value: publicBaseUrl
  }
  {
    name: 'GATEWAY_KEY_WRAPPER'
    value: 'azure-key-vault'
  }
  {
    name: 'GATEWAY_AZURE_KEY_VAULT_KEY_ID'
    value: keyVaultKeyId
  }
  {
    name: 'AZURE_MANAGED_IDENTITY_CLIENT_ID'
    value: managedIdentityClientId
  }
], empty(agentSdkUrl) ? [] : [
  {
    name: 'GATEWAY_ANTHROPIC_AGENT_SDK_URL'
    value: agentSdkUrl
  }
  {
    name: 'GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY'
    secretRef: 'agent-sdk-api-key'
  }
  {
    name: 'GATEWAY_ANTHROPIC_AGENT_SDK_ALLOW_INSECURE'
    value: agentSdkAllowInsecure ? 'true' : 'false'
  }
  {
    name: 'GATEWAY_ANTHROPIC_AGENT_SDK_MODEL_REWRITES_JSON'
    value: agentSdkModelRewritesJson
  }
])

resource dataApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-data'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: commonSecrets
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: image
          env: concat(commonEnv, [
            {
              name: 'GATEWAY_ROLE'
              value: 'data'
            }
            {
              name: 'GATEWAY_DATA_HOST'
              value: '0.0.0.0'
            }
          ])
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health/live', port: 8080 }
              initialDelaySeconds: 10
              periodSeconds: 20
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health/ready', port: 8080 }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 10
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '20' } }
          }
        ]
      }
    }
  }
}

resource controlApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-control'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: commonSecrets
      ingress: {
        external: false
        allowInsecure: false
        targetPort: 8081
        transport: 'auto'
        traffic: [
          { latestRevision: true, weight: 100 }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: image
          env: concat(commonEnv, [
            { name: 'GATEWAY_ROLE', value: 'control' }
            { name: 'GATEWAY_CONTROL_HOST', value: '0.0.0.0' }
          ])
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health/live', port: 8081 }
              initialDelaySeconds: 10
              periodSeconds: 20
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health/ready', port: 8081 }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 2 }
    }
  }
}

resource workerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-worker'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: image
          env: concat(commonEnv, [
            { name: 'GATEWAY_ROLE', value: 'worker' }
            { name: 'GATEWAY_CONTROL_HOST', value: '0.0.0.0' }
          ])
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

resource migrationJob 'Microsoft.App/jobs@2024-03-01' = {
  name: '${namePrefix}-migrate'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: [
        { name: 'database-url', value: migrationDatabaseUrl }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: migratorImage
          env: [
            { name: 'GATEWAY_DATABASE_URL', secretRef: 'database-url' }
            { name: 'GATEWAY_MIGRATION_EXPECTED_HOST', value: migrationExpectedHost }
            { name: 'GATEWAY_MIGRATION_EXPECTED_DATABASE', value: migrationExpectedDatabase }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
    }
  }
}

output dataFqdn string = dataApp.properties.configuration.ingress.fqdn
output controlFqdn string = controlApp.properties.configuration.ingress.fqdn
output migrationJobName string = migrationJob.name
