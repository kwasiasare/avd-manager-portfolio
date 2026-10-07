// Static Web App module (AM-9 / M1).
// Hosts the app/frontend build. The API is a *linked* Function App (see
// functionapp.bicep), not the SWA's built-in managed API, so the frontend
// deploy workflow uses skip_api_build.
//
// Note: SWA Standard is only available in a limited set of regions — eastus2
// is the nearest supported region to this deployment's primary eastus
// footprint (see infra/main.bicep's `swaLocation`; every other
// resource stays in eastus). `location` here is intentionally a separate
// param from the rest of infra/main.bicep's `location` for that reason.
param location string
param staticWebAppName string
param tags object = {}

@description('SWA SKU. Standard is required to link an external/BYO Function App backend.')
param skuName string = 'Standard'

@description('Resource ID of the Function App to link as this SWA backend. Empty skips linking (e.g. a first deploy before the Function App exists).')
param linkedBackendResourceId string = ''

@description('Region of the linked Function App (required by the linkedBackends resource; must match a region SWA can reach).')
param linkedBackendLocation string = location

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuName
  }
  properties: {
    // TODO(M1+): set buildProperties / repositoryUrl if switching to SWA-native CI,
    // or leave empty when deploying from an external pipeline (e.g. GitHub Actions)
    // using the SWA deployment token.
    provider: 'GitHub'
  }
}

// Links the Function App (functionapp.bicep) as this SWA's backend so
// requests to /api/* are forwarded to it and x-ms-client-principal is
// injected — this is what actually wires the two resources together
// post-deploy; without it, the Function App is deployed but unreachable
// through the SWA's /api/* routes. Skipped (via linkedBackendResourceId
// being empty) is only useful for a bootstrap-order deploy; normal deploys
// always pass it.
resource linkedBackend 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = if (!empty(linkedBackendResourceId)) {
  parent: staticWebApp
  name: 'avdmgr-api'
  properties: {
    backendResourceId: linkedBackendResourceId
    region: linkedBackendLocation
  }
}

output name string = staticWebApp.name
output defaultHostname string = staticWebApp.properties.defaultHostname
