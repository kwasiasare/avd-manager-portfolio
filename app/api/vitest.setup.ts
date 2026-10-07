// Neutral fixture values for the estate-specific settings that config.ts
// requires (it has no built-in defaults for them). Individual tests may still
// override or delete any of these.
const defaults: Record<string, string> = {
  STORAGE_ACCOUNT_NAME: 'stcontoso001',
  VNET_NAME: 'VNET-CONTOSO-PROD',
  WORKSPACE_NAME: 'Contoso-Desktop',
  DAG_NAME: 'HP-CONTOSO-PROD-DAG',
  GALLERY_NAME: 'ACG_AVD_CONTOSO',
  KEY_VAULT_NAME: 'KV-AVD-CONTOSO',
  SESSION_HOST_ADMIN_USERNAME: 'avdadmin',
};
for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
