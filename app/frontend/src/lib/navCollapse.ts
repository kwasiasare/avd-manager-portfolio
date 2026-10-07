/**
 * AM-31 item 34 — persisted manual nav-collapse preference, same
 * localStorage read/write shape theme/AppThemeProvider.tsx uses for its own
 * mode preference (guarded against localStorage being unavailable — falls
 * back to the in-session default rather than throwing).
 */
const STORAGE_KEY = 'avdmgr.navCollapsed';

export function readStoredNavCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeStoredNavCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(collapsed));
  } catch {
    // Best-effort persistence only — a write failure (quota, disabled storage) must not break the in-session toggle.
  }
}
