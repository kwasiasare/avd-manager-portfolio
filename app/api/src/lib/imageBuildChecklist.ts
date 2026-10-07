import { IMAGE_BUILD_CHECKLIST, type ImageBuildChecklistState } from '@avdmgr/shared';

/**
 * AM-27 (M4-S2) — server-side checklist_gate helpers. The checklist
 * DEFINITION (the ordered list of items, each citing a
 * The golden-image runbook section) lives in @avdmgr/shared so
 * app/frontend renders the exact same items; this file holds only the
 * validation logic the API needs, so it isn't duplicated between the
 * PATCH .../checklist handler and the POST .../advance handler (both must
 * agree on "is the gate satisfied").
 */

/** A fresh, all-unticked checklist state for a newly created build. */
export function emptyChecklistState(): ImageBuildChecklistState {
  const state: ImageBuildChecklistState = {};
  for (const item of IMAGE_BUILD_CHECKLIST) {
    state[item.id] = false;
  }
  return state;
}

/** True only when this item id is one of the fixed checklist's — guards PATCH .../checklist against an arbitrary/typo'd itemId silently no-op'ing into the stored JSON blob. */
export function isKnownChecklistItem(itemId: string): boolean {
  return IMAGE_BUILD_CHECKLIST.some((item) => item.id === itemId);
}

/**
 * THE checklist_gate hard requirement: every item must be ticked true
 * before POST .../advance is allowed to move a build from checklist_gate to
 * snapshotting. An item simply absent from the stored state (shouldn't
 * happen once emptyChecklistState is always used to seed a new build, but
 * defensive regardless) counts as unticked, not ticked.
 */
export function allRequiredChecklistItemsChecked(checklist: ImageBuildChecklistState): boolean {
  return IMAGE_BUILD_CHECKLIST.every((item) => checklist[item.id] === true);
}

/** Ids of every item still unticked — surfaced in the 409 the advance handler returns when the gate isn't satisfied yet, so the operator sees exactly what's missing rather than a bare rejection. */
export function unchecklistedItemIds(checklist: ImageBuildChecklistState): string[] {
  return IMAGE_BUILD_CHECKLIST.filter((item) => checklist[item.id] !== true).map((item) => item.id);
}
