targetScope = 'resourceGroup'

@description('Name of the gateway-only manual migration job.')
param jobName string

param location string = resourceGroup().location

@description('Existing Container Apps environment. No environment configuration is changed.')
param containerAppsEnvironmentId string

@description('Gateway identity with AcrPull on the gateway registry.')
param managedIdentityResourceId string

param acrLoginServer string

@description('CI-published migrator image pinned by digest.')
param migratorImage string

@secure()
@description('Schema-owner connection to the dedicated gateway database, never a runtime connection.')
param migrationDatabaseUrl string

param migrationExpectedHost string
param migrationExpectedDatabase string = 'llm_gateway'
param tags object = {}

resource migrationJob 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${managedIdentityResourceId}': {} }
  }
  properties: {
    environmentId: containerAppsEnvironmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [
        { server: acrLoginServer, identity: managedIdentityResourceId }
      ]
      secrets: [
        { name: 'migration-database-url', value: migrationDatabaseUrl }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: migratorImage
          env: [
            { name: 'GATEWAY_DATABASE_URL', secretRef: 'migration-database-url' }
            { name: 'GATEWAY_MIGRATION_EXPECTED_HOST', value: migrationExpectedHost }
            { name: 'GATEWAY_MIGRATION_EXPECTED_DATABASE', value: migrationExpectedDatabase }
          ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}

output migrationJobId string = migrationJob.id
output migrationJobName string = migrationJob.name
