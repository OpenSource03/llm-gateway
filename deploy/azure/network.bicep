targetScope = 'resourceGroup'

@description('Region for the gateway network, plan, and job environment.')
param location string = resourceGroup().location

param vnetName string
@description('Must not overlap any network that will be peered with this one.')
param addressPrefix string
@description('App Service VNet integration subnet, delegated to Microsoft.Web/serverFarms.')
param appServiceSubnetPrefix string
param privateEndpointSubnetPrefix string
@description('Container Apps job subnet, delegated to Microsoft.App/environments; at least a /27.')
param containerAppsSubnetPrefix string

param appServicePlanName string
@description('Linux plan hosting the data, control, and optional Agent SDK bridge apps.')
param appServicePlanSku string = 'P1v3'

param containerAppsEnvironmentName string
param logAnalyticsWorkspaceName string
param logRetentionDays int = 90

param tags object = {}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
  }
}

// Child resources, so a redeploy never removes subnets added outside this template.
// Azure updates one subnet of a VNet at a time.
resource appServiceSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-appservice'
  properties: {
    addressPrefix: appServiceSubnetPrefix
    delegations: [
      {
        name: 'appservice'
        properties: { serviceName: 'Microsoft.Web/serverFarms' }
      }
    ]
  }
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-private-endpoints'
  properties: {
    addressPrefix: privateEndpointSubnetPrefix
    privateEndpointNetworkPolicies: 'Disabled'
  }
  dependsOn: [appServiceSubnet]
}

resource containerAppsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-container-apps'
  properties: {
    addressPrefix: containerAppsSubnetPrefix
    delegations: [
      {
        name: 'containerapps'
        properties: { serviceName: 'Microsoft.App/environments' }
      }
    ]
  }
  dependsOn: [privateEndpointSubnet]
}

resource postgresDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresDnsZone
  name: 'gateway-network'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: appServicePlanSku }
  properties: { reserved: true }
}

// Only the Consumption profile: no dedicated profile, so no plan management charge.
resource jobEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppsEnvironmentName
  location: location
  tags: tags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: containerAppsSubnet.id
      internal: true
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
    zoneRedundant: false
  }
}

output virtualNetworkId string = vnet.id
output appServiceSubnetId string = appServiceSubnet.id
output privateEndpointSubnetId string = privateEndpointSubnet.id
output postgresPrivateDnsZoneId string = postgresDnsZone.id
output appServicePlanId string = plan.id
output containerAppsEnvironmentId string = jobEnvironment.id
output logAnalyticsWorkspaceId string = workspace.id
