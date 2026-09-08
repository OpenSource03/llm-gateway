targetScope = 'resourceGroup'

@description('Region for the new gateway-owned resources.')
param location string = resourceGroup().location

@description('Globally unique name for a new dedicated PostgreSQL Flexible Server.')
@minLength(3)
@maxLength(63)
param postgresServerName string

@description('Globally unique alphanumeric name for a new Basic ACR.')
@minLength(5)
@maxLength(50)
param acrName string

@description('Globally unique name for a new gateway-only Standard Key Vault.')
@minLength(3)
@maxLength(24)
param keyVaultName string

@description('Name of the new gateway runtime user-assigned identity.')
param runtimeIdentityName string

@description('Name of the new RSA key used only for gateway credential envelopes.')
param wrappingKeyName string = 'gateway-envelope'

@description('Existing private-endpoint subnet. This module does not modify the subnet or VNet.')
param privateEndpointSubnetId string

@description('Region of the existing private-endpoint subnet.')
param privateEndpointLocation string = location

@description('Existing privatelink.postgres.database.azure.com zone already linked to the gateway VNet.')
param postgresPrivateDnsZoneId string

@description('Existing VNet ID used only when creating the new App Service private DNS zone link.')
param virtualNetworkId string

@description('Create privatelink.azurewebsites.net only after confirming the VNet has no existing zone with that name.')
param createAppServicePrivateDnsZone bool = false

@description('Existing App Service private DNS zone ID when createAppServicePrivateDnsZone is false.')
param existingAppServicePrivateDnsZoneId string = ''

@description('Initial owner login for the new server. Used only by the separately run migration/bootstrap job.')
param adminLogin string = 'gateway_owner'

@secure()
@minLength(16)
@description('Approved initial server-owner password. Persist and reuse the same secret on later deployments.')
param adminPassword string

@description('DML-only login to create out-of-band on the new gateway database after migrations.')
param runtimeLogin string = 'gateway_runtime'

@secure()
@minLength(16)
@description('Password for the runtime login. This module stores it in a connection string but does not create the PostgreSQL login.')
param runtimePassword string

@secure()
@minLength(32)
@description('Gateway-only session HMAC secret; persist and reuse it on later deployments.')
param sessionHmacSecret string

param tags object = {}

var databaseName = 'llm_gateway'
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var wrappingRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'e147488a-f6f5-4113-8e2d-b22465e65bf6')

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: runtimeIdentityName
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: acrName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, runtimeIdentity.id, acrPullRoleId)
  scope: registry
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleId
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: { bypass: 'None', defaultAction: 'Allow' }
  }
}

resource wrappingKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = {
  parent: vault
  name: wrappingKeyName
  properties: {
    kty: 'RSA'
    keySize: 3072
    keyOps: ['wrapKey', 'unwrapKey']
    attributes: { enabled: true, exportable: false }
  }
}

resource wrappingPermission 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(wrappingKey.id, runtimeIdentity.id, wrappingRoleId)
  scope: wrappingKey
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: wrappingRoleId
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    createMode: 'Default'
    version: '16'
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
    network: { publicNetworkAccess: 'Disabled' }
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource postgresPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${postgresServerName}-pe'
  location: privateEndpointLocation
  tags: tags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: '${postgresServerName}-postgresql'
        properties: {
          privateLinkServiceId: postgres.id
          groupIds: ['postgresqlServer']
        }
      }
    ]
  }
}

resource postgresPrivateDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: postgresPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'postgres', properties: { privateDnsZoneId: postgresPrivateDnsZoneId } }
    ]
  }
}

resource appServicePrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createAppServicePrivateDnsZone) {
  name: 'privatelink.azurewebsites.net'
  location: 'global'
  tags: tags
}

resource appServiceDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createAppServicePrivateDnsZone) {
  parent: appServicePrivateDnsZone
  name: 'gateway-runtime'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: virtualNetworkId }
  }
}

resource migrationDatabaseSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'migration-database-url'
  properties: {
    contentType: 'application/x-postgresql-connection-string'
    value: 'postgresql://${uriComponent(adminLogin)}:${uriComponent(adminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=verify-full'
  }
}

resource runtimeDatabaseSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'runtime-database-url'
  properties: {
    contentType: 'application/x-postgresql-connection-string'
    value: 'postgresql://${uriComponent(runtimeLogin)}:${uriComponent(runtimePassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=verify-full'
  }
}

resource sessionHmacSecretResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'session-hmac'
  properties: { value: sessionHmacSecret }
}

output postgresServerId string = postgres.id
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output gatewayDatabaseName string = databaseName
output postgresPrivateEndpointId string = postgresPrivateEndpoint.id
output acrId string = registry.id
output acrLoginServer string = registry.properties.loginServer
output keyVaultId string = vault.id
output keyVaultName string = vault.name
output keyVaultUri string = vault.properties.vaultUri
output keyUriWithVersion string = wrappingKey.properties.keyUriWithVersion
output managedIdentityResourceId string = runtimeIdentity.id
output managedIdentityClientId string = runtimeIdentity.properties.clientId
output managedIdentityPrincipalId string = runtimeIdentity.properties.principalId
output appServicePrivateDnsZoneId string = createAppServicePrivateDnsZone
  ? appServicePrivateDnsZone.id
  : existingAppServicePrivateDnsZoneId
