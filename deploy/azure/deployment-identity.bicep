targetScope = 'resourceGroup'

param identityName string
param location string = resourceGroup().location

@description('GitHub owner/repository allowed to deploy this gateway resource group.')
param githubRepository string

param githubEnvironment string = 'azure-production'

@description('Exact GitHub-issued OIDC subject. Supply the immutable owner/repository ID form when enabled by GitHub.')
param federatedSubject string = 'repo:${githubRepository}:environment:${githubEnvironment}'

resource deploymentIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource githubTrust 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deploymentIdentity
  name: 'github-gateway-production'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: federatedSubject
    audiences: ['api://AzureADTokenExchange']
  }
}

var contributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
var acrPushRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')

// This module belongs in a dedicated gateway resource group, never a shared group.
resource contributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deploymentIdentity.id, contributorRoleId)
  properties: {
    principalId: deploymentIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributorRoleId
  }
}

resource acrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deploymentIdentity.id, acrPushRoleId)
  properties: {
    principalId: deploymentIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPushRoleId
  }
}

output clientId string = deploymentIdentity.properties.clientId
output principalId string = deploymentIdentity.properties.principalId
output identityId string = deploymentIdentity.id
