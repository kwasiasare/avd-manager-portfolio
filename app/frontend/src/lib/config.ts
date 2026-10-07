/** Frontend-side config, sourced from Vite env vars (see vite-env.d.ts). Keep in sync with the API's own app settings per environment. */
export const HOST_POOL_NAME = import.meta.env.VITE_HOSTPOOL_NAME ?? 'HP-CONTOSO-PROD';

/**
 * AM-15 (M7) — Settings page "Links" card.
 *
 * SWA_URL: Opus peer review MAJOR fix — this originally defaulted to the
 * hard-coded prod hostname (example-...), which is WRONG for any
 * other environment this app is served from: this app's mandated dev
 * pattern is an SWA PREVIEW environment on the SAME resource (see the
 * global Azure-preferences policy — "Dev Environments = Preview, Not
 * Separate Resources"), each with its OWN generated hostname. A prod-only
 * default silently linked a preview environment's own Settings page back to
 * PROD, actively misleading exactly the deploy-verification workflow this
 * card exists to support. `window.location.origin` is correct in every
 * case that matters — the frontend is always served BY the SWA/preview
 * environment it should link back to — so this now needs no hardcoded
 * fallback at all; VITE_SWA_URL remains available only for the rare case of
 * rendering this page from a non-SWA-served context (e.g. `vite dev`
 * locally without SWA CLI, where window.location.origin would be
 * localhost).
 *
 * JIRA_PROJECT_URL / CONFLUENCE_SPACE_URL have NO built-in default — unlike
 * the SWA origin, this app has no verified Jira/Confluence site domain
 * anywhere in this repo to fall back to, and a fabricated one would be a
 * dead (or worse, someone else's real) link. Both stay undefined until an
 * operator sets VITE_JIRA_PROJECT_URL / VITE_CONFLUENCE_SPACE_URL for their
 * environment; the Settings page shows "Not configured" rather than a
 * guessed URL, matching this app's existing not-configured-over-fabricated
 * convention (see e.g. SettingsResponse.groupIds in @avdmgr/shared).
 */
export const SWA_URL = import.meta.env.VITE_SWA_URL ?? (typeof window !== 'undefined' ? window.location.origin : '');
export const JIRA_PROJECT_URL = import.meta.env.VITE_JIRA_PROJECT_URL;
export const CONFLUENCE_SPACE_URL = import.meta.env.VITE_CONFLUENCE_SPACE_URL;

/**
 * AM-29 Wave 1 peer review (Opus, MAJOR item 4) — shared by CostScaling.tsx
 * (its own cost-related polls) and Dashboard.tsx's cost tile, so both poll
 * GET /v1/cost/summary at the SAME cadence rather than each hand-rolling
 * its own literal (the Dashboard tile originally reused the page's generic
 * 60s POLL_INTERVAL_MS, needlessly waking a scale-to-zero Function App for
 * a number that only meaningfully changes every few minutes).
 */
export const COST_POLL_INTERVAL_MS = 5 * 60_000;
