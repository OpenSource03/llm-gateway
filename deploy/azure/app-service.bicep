targetScope = 'resourceGroup'

@description('Globally unique name for the public data-plane app.')
@minLength(2)
@maxLength(60)
param dataAppName string

@description('Globally unique name for the private control-plane app; different from dataAppName.')
@minLength(2)
@maxLength(60)
param controlAppName string

@description('Region of the existing Linux App Service plan and integration subnet.')
param location string = resourceGroup().location

@description('Existing Linux App Service plan supporting Always On and VNet integration.')
param appServicePlanId string

@description('Existing subnet delegated to Microsoft.Web/serverFarms, with capacity for both apps.')
param integrationSubnetId string

@description('Existing private-endpoint subnet, distinct from the integration subnet.')
param privateEndpointSubnetId string

@description('Region of the private-endpoint subnet.')
param privateEndpointLocation string = location

@description('Existing privatelink.azurewebsites.net zone, already linked to the control clients VNet or DNS resolver.')
param privateDnsZoneId string

@description('Existing dedicated gateway user-assigned identity; do not reuse an integrating application identity.')
param managedIdentityResourceId string

@description('Client ID of the dedicated gateway identity, used for ACR and Key Vault.')
param managedIdentityClientId string

@description('Runtime image in the existing ACR, including registry host and an immutable digest or commit tag.')
param image string

@description('ACR login hostname, without a scheme or path; must match the image registry.')
param acrLoginServer string

@secure()
@description('DML-only connection string to the dedicated gateway PostgreSQL database. Never supply the migration owner.')
param runtimeDatabaseUrl string

@secure()
@description('Shared gateway session HMAC secret, at least 32 characters.')
@minLength(32)
param sessionHmacSecret string

@description('Immutable versioned Azure Key Vault RSA wrapping-key URL.')
param keyVaultKeyId string

@description('Canonical public HTTPS base URL used by gateway discovery.')
param publicBaseUrl string

@description('Route application internet egress through the VNet only when its routing permits provider HTTPS access.')
param vnetRouteAllEnabled bool = false

@description('Route image pulls through the VNet; enable for a network-protected ACR with working private DNS.')
param vnetImagePullEnabled bool = false

@description('Optional deployment-owned HTTPS URL of a separately deployed private Agent SDK bridge.')
param agentSdkUrl string = ''

@secure()
param agentSdkApiKey string = ''

@description('Bounded JSON array of external bridge catalog corrections.')
param agentSdkModelRewritesJson string = '[]'

param tags object = {}

var commonSettings = concat([
  { name: 'NODE_ENV', value: 'production' }
  { name: 'GATEWAY_DATABASE_URL', value: runtimeDatabaseUrl }
  { name: 'GATEWAY_DATABASE_SSL_MODE', value: 'verify-full' }
  { name: 'GATEWAY_SESSION_HMAC_SECRET', value: sessionHmacSecret }
  { name: 'GATEWAY_KEY_WRAPPER', value: 'azure-key-vault' }
  { name: 'GATEWAY_AZURE_KEY_VAULT_KEY_ID', value: keyVaultKeyId }
  { name: 'AZURE_MANAGED_IDENTITY_CLIENT_ID', value: managedIdentityClientId }
  { name: 'GATEWAY_PUBLIC_URL', value: publicBaseUrl }
  { name: 'DOCKER_REGISTRY_SERVER_URL', value: 'https://${acrLoginServer}' }
  { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
  { name: 'WEBSITES_CONTAINER_START_TIME_LIMIT', value: '600' }
  { name: 'WEBSITE_WARMUP_PATH', value: '/health/ready' }
  { name: 'WEBSITE_WARMUP_STATUSES', value: '200' }
], empty(agentSdkUrl) ? [] : [
  { name: 'GATEWAY_ANTHROPIC_AGENT_SDK_URL', value: agentSdkUrl }
  { name: 'GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY', value: agentSdkApiKey }
  { name: 'GATEWAY_ANTHROPIC_AGENT_SDK_ALLOW_INSECURE', value: 'false' }
  { name: 'GATEWAY_ANTHROPIC_AGENT_SDK_MODEL_REWRITES_JSON', value: agentSdkModelRewritesJson }
])

var commonSiteConfig = {
  linuxFxVersion: 'DOCKER|${image}'
  appCommandLine: ''
  acrUseManagedIdentityCreds: true
  acrUserManagedIdentityID: managedIdentityClientId
  alwaysOn: true
  ftpsState: 'Disabled'
  minTlsVersion: '1.2'
  scmMinTlsVersion: '1.2'
  http20Enabled: true
  remoteDebuggingEnabled: false
  healthCheckPath: '/health/ready'
  scmIpSecurityRestrictionsDefaultAction: 'Deny'
}

resource dataApp 'Microsoft.Web/sites@2024-11-01' = {
  name: dataAppName
  location: location
  kind: 'app,linux,container'
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${managedIdentityResourceId}': {} }
  }
  properties: {
    serverFarmId: appServicePlanId
    httpsOnly: true
    clientAffinityEnabled: false
    publicNetworkAccess: 'Enabled'
    virtualNetworkSubnetId: integrationSubnetId
    outboundVnetRouting: {
      applicationTraffic: vnetRouteAllEnabled
      imagePullTraffic: vnetImagePullEnabled
    }
    siteConfig: union(commonSiteConfig, {
      appSettings: concat(commonSettings, [
        { name: 'GATEWAY_ROLE', value: 'all' }
        { name: 'GATEWAY_DATA_HOST', value: '0.0.0.0' }
        { name: 'GATEWAY_DATA_PORT', value: '8080' }
        { name: 'GATEWAY_CONTROL_HOST', value: '127.0.0.1' }
        { name: 'GATEWAY_CONTROL_PORT', value: '8081' }
        { name: 'WEBSITES_PORT', value: '8080' }
      ])
    })
  }
}

resource controlApp 'Microsoft.Web/sites@2024-11-01' = {
  name: controlAppName
  location: location
  kind: 'app,linux,container'
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${managedIdentityResourceId}': {} }
  }
  properties: {
    serverFarmId: appServicePlanId
    httpsOnly: true
    clientAffinityEnabled: false
    publicNetworkAccess: 'Disabled'
    virtualNetworkSubnetId: integrationSubnetId
    outboundVnetRouting: {
      applicationTraffic: vnetRouteAllEnabled
      imagePullTraffic: vnetImagePullEnabled
    }
    siteConfig: union(commonSiteConfig, {
      appSettings: concat(commonSettings, [
        { name: 'GATEWAY_ROLE', value: 'control' }
        { name: 'GATEWAY_CONTROL_HOST', value: '0.0.0.0' }
        { name: 'GATEWAY_CONTROL_PORT', value: '8081' }
        { name: 'WEBSITES_PORT', value: '8081' }
      ])
    })
  }
}

resource dataFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: dataApp
  name: 'ftp'
  properties: { allow: false }
}

resource dataScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: dataApp
  name: 'scm'
  properties: { allow: false }
}

resource controlFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: controlApp
  name: 'ftp'
  properties: { allow: false }
}

resource controlScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: controlApp
  name: 'scm'
  properties: { allow: false }
}

resource controlPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${controlAppName}-pe'
  location: privateEndpointLocation
  tags: tags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: '${controlAppName}-sites'
        properties: {
          privateLinkServiceId: controlApp.id
          groupIds: ['sites']
        }
      }
    ]
  }
}

resource controlPrivateDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: controlPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'app-service', properties: { privateDnsZoneId: privateDnsZoneId } }
    ]
  }
}

output dataAppId string = dataApp.id
output controlAppId string = controlApp.id
output dataDefaultHostname string = dataApp.properties.defaultHostName
output controlDefaultHostname string = controlApp.properties.defaultHostName
output controlBaseUrl string = 'https://${controlApp.properties.defaultHostName}/admin/v1'
output controlPrivateEndpointId string = controlPrivateEndpoint.id
