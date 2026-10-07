import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentTitle } from './useDocumentTitle';

describe('useDocumentTitle', () => {
  it('sets document.title to "AVD Manager — <page>"', () => {
    renderHook(() => useDocumentTitle('Dashboard'));
    expect(document.title).toBe('AVD Manager — Dashboard');
  });

  it('updates the title when the page title prop changes', () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), { initialProps: { title: 'Dashboard' } });
    expect(document.title).toBe('AVD Manager — Dashboard');

    rerender({ title: 'Host Pool' });
    expect(document.title).toBe('AVD Manager — Host Pool');
  });

  it('restores the previous title on unmount', () => {
    document.title = 'Some other title';
    const { unmount } = renderHook(() => useDocumentTitle('Sessions'));
    expect(document.title).toBe('AVD Manager — Sessions');

    unmount();
    expect(document.title).toBe('Some other title');
  });
});
