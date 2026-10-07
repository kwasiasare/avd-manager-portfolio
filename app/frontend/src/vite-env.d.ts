/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL for API calls. Defaults to '/api' (same-origin, via SWA linked Function App). */
  readonly VITE_API_BASE?: string;
  /** Dev-only role override so the app is usable without SWA auth locally. Never used in production. */
  readonly VITE_DEV_ROLE?: 'viewer' | 'operator' | 'admin';
  /**
   * Name of the AVD host pool the M1 UI is scoped to. M1 manages a single
   * host pool (mirrors the API's HOSTPOOL_NAME app setting) — must stay in
   * sync with that setting per environment. Defaults to 'HP-CONTOSO-PROD'.
   */
  readonly VITE_HOSTPOOL_NAME?: string;
  /** AM-15 (M7) — Settings page "Links" card. See lib/config.ts's SWA_URL/JIRA_PROJECT_URL/CONFLUENCE_SPACE_URL doc comment. */
  readonly VITE_SWA_URL?: string;
  readonly VITE_JIRA_PROJECT_URL?: string;
  readonly VITE_CONFLUENCE_SPACE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** AM-15 (M7) — build-time version stamp injected by vite.config.ts's `define`, sourced from app/frontend/package.json. See Settings.tsx. */
declare const __APP_VERSION__: string;
