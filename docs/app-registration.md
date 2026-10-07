# App registration and managed-identity prerequisites

This is a condensed, estate-neutral version of the deployment runbook that
code comments refer to. Section numbers quoted in comments (for example
"DEPLOY-PREREQS 0.1", "section 9", "§12") refer to the original, more detailed
private runbook; the requirement behind each reference is summarised below.
Nothing here is performed by `infra/main.bicep` — these are one-time manual
steps per environment.

## 1. Before the Bicep deploy (DEPLOY-PREREQS)

1. Register the `Microsoft.App` resource provider in the target subscription
   (`az provider register -n Microsoft.App --wait`). Flex Consumption VNet
   integration runs on this provider.
2. Delegate the Function App's integration subnet to
   `Microsoft.App/environments` (not `Microsoft.Web/serverFarms`). The subnet
   is pre-existing and is not modified by Bicep.
3. Keep `vnetRouteAllEnabled` false unless hub-firewall allow rules exist for
   `management.azure.com` and the Microsoft Graph endpoints the API calls.
4. Golden-image builds need a separate, explicitly named build subnet
   (`imageBuildSubnetName`) that the build VM's NIC can be placed in.

## 2. Entra ID app registration (Static Web Apps sign-in)

1. Register an application in your tenant with the SWA redirect URI
   `https://<your-swa-host>/.auth/login/aad/callback` and enable ID token issuance.
2. Store the client ID and secret as Static Web App application settings
   (`AZURE_CLIENT_ID`, and the setting named by `clientSecretSettingName` in
   `staticwebapp.config.json`). Never commit either value.
3. Build the frontend with `SWA_TENANT_ID=<your tenant id>` so the tenant is
   rendered into `staticwebapp.config.json`.

## 3. Role groups

Create three Entra security groups (viewer, operator, admin) and pass their
object IDs to the Function App as `GROUP_ID_VIEWER`, `GROUP_ID_OPERATOR`,
`GROUP_ID_ADMIN` (Bicep parameters `groupIdViewer` / `groupIdOperator` /
`groupIdAdmin`). Optionally create a break-glass group and pass its object ID
as `breakGlassGroupId` for the Conditional Access governance check.

## 4. Function App managed identity

Azure RBAC is granted by `infra/main.bicep` and `infra/modules/` (custom,
least-privilege role definitions scoped per resource group).

Microsoft Graph **application** permissions are not grantable from Bicep and
must be consented manually to the managed identity (`az rest` against the
Graph `appRoleAssignments` endpoint, or the Entra admin center). Features that
depend on them degrade gracefully when absent:

| Permission | Used by |
| --- | --- |
| `User.Read.All` | user search and profile-owner resolution |
| `GroupMember.Read.All` | access assignments (group membership) |
| `Policy.Read.All` | Conditional Access break-glass governance check |
| `DeviceManagementConfiguration.Read.All`, `DeviceManagementManagedDevices.Read.All` | Intune policy-health panel |

Grant the FSLogix data-plane role (`Storage File Data Privileged Contributor`)
on the profile storage account to the Function App identity; the baseline
holder's object ID is then supplied back as `privilegedStorageBaselinePrincipalId`
so the privileged-access governance check can distinguish expected from
unexpected holders.

## 5. Post-deploy verification

- Cost Management: confirm the identity holds `Cost Management Reader` on each
  tracked resource group (see `app/README.md`, "Cost Management verification").
- Log Analytics: confirm `Log Analytics Reader` on the monitoring workspace.
- Call `GET /api/v1/health` on the deployed Function App and confirm
  `versionSource` is as expected for your deployment method.
