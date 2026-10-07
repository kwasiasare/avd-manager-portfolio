import { describe, expect, it } from 'vitest';
import { IMAGE_BUILD_CHECKLIST } from '@avdmgr/shared';
import { allRequiredChecklistItemsChecked, emptyChecklistState, isKnownChecklistItem, unchecklistedItemIds } from './imageBuildChecklist';

describe('emptyChecklistState', () => {
  it('seeds every checklist item as unticked', () => {
    const state = emptyChecklistState();
    expect(Object.keys(state)).toHaveLength(IMAGE_BUILD_CHECKLIST.length);
    expect(Object.values(state).every((v) => v === false)).toBe(true);
  });
});

describe('isKnownChecklistItem', () => {
  it('accepts every real item id', () => {
    for (const item of IMAGE_BUILD_CHECKLIST) {
      expect(isKnownChecklistItem(item.id)).toBe(true);
    }
  });

  it('rejects an unknown/typo\'d id — guards against a silent no-op write', () => {
    expect(isKnownChecklistItem('not_a_real_item')).toBe(false);
  });
});

describe('allRequiredChecklistItemsChecked', () => {
  it('is false for a freshly-seeded (all-unticked) checklist', () => {
    expect(allRequiredChecklistItemsChecked(emptyChecklistState())).toBe(false);
  });

  it('is false when even one item is unticked', () => {
    const state = emptyChecklistState();
    for (const item of IMAGE_BUILD_CHECKLIST) state[item.id] = true;
    state[IMAGE_BUILD_CHECKLIST[0].id] = false;
    expect(allRequiredChecklistItemsChecked(state)).toBe(false);
  });

  it('is true only once every single item is true', () => {
    const state = emptyChecklistState();
    for (const item of IMAGE_BUILD_CHECKLIST) state[item.id] = true;
    expect(allRequiredChecklistItemsChecked(state)).toBe(true);
  });

  it('treats an item absent from the stored state as unticked, not ticked', () => {
    expect(allRequiredChecklistItemsChecked({})).toBe(false);
  });
});

describe('unchecklistedItemIds', () => {
  it('lists exactly the unticked items, surfaced for the 409 the advance handler returns', () => {
    const state = emptyChecklistState();
    for (const item of IMAGE_BUILD_CHECKLIST) state[item.id] = true;
    state[IMAGE_BUILD_CHECKLIST[0].id] = false;
    state[IMAGE_BUILD_CHECKLIST[1].id] = false;
    expect(unchecklistedItemIds(state)).toEqual([IMAGE_BUILD_CHECKLIST[0].id, IMAGE_BUILD_CHECKLIST[1].id]);
  });
});
