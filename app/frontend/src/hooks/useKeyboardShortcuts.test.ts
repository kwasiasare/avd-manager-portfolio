import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { NAV_SHORTCUTS, useKeyboardShortcuts, visibleNavShortcuts } from './useKeyboardShortcuts';

/**
 * AM-34 peer review (Opus, MINOR 9) — first test file to touch
 * NAV_SHORTCUTS at all. Covers two things this app's AM-34 work (the
 * Incident page) added to this registry: the `g n` chord itself
 * (dispatcher-level, via useKeyboardShortcuts) and visibleNavShortcuts'
 * role filtering (RULING 13 — see that function's own doc comment).
 */

function Harness({ navigate, openHelp, openCommandPalette }: { navigate: NavigateFunction; openHelp: () => void; openCommandPalette: () => void }) {
  useKeyboardShortcuts(navigate, openHelp, openCommandPalette);
  return null;
}

describe('NAV_SHORTCUTS — g n (AM-34)', () => {
  it('registers Incident at the g n chord', () => {
    expect(NAV_SHORTCUTS.find((shortcut) => shortcut.keys === 'g n')).toEqual({ keys: 'g n', label: 'Incident', to: '/incident', minRole: 'operator' });
  });

  it('dispatches g n to /incident', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn() as unknown as NavigateFunction;
    render(createElement(Harness, { navigate, openHelp: vi.fn(), openCommandPalette: vi.fn() }));

    await user.keyboard('gn');

    expect(navigate).toHaveBeenCalledWith('/incident');
  });

  it('the chord dispatcher matches regardless of role — minRole only affects display surfaces, not the dispatcher itself (see NAV_SHORTCUTS/visibleNavShortcuts doc comments)', async () => {
    // No role is threaded through useKeyboardShortcuts at all — this test
    // documents that the dispatcher has nothing to gate on in the first
    // place, i.e. there's no code path here that COULD special-case
    // minRole even if it wanted to.
    const user = userEvent.setup();
    const navigate = vi.fn() as unknown as NavigateFunction;
    render(createElement(Harness, { navigate, openHelp: vi.fn(), openCommandPalette: vi.fn() }));

    await user.keyboard('gt');

    expect(navigate).toHaveBeenCalledWith('/audit');
  });
});

describe('visibleNavShortcuts (AM-34 RULING 13)', () => {
  it('includes operator-only rows (Audit, Incident) for an operator', () => {
    const visible = visibleNavShortcuts('operator');
    expect(visible.some((shortcut) => shortcut.to === '/incident')).toBe(true);
    expect(visible.some((shortcut) => shortcut.to === '/audit')).toBe(true);
  });

  it('includes operator-only rows for an admin', () => {
    const visible = visibleNavShortcuts('admin');
    expect(visible.some((shortcut) => shortcut.to === '/incident')).toBe(true);
    expect(visible.some((shortcut) => shortcut.to === '/audit')).toBe(true);
  });

  it('excludes operator-only rows for a viewer, while keeping ordinary rows', () => {
    const visible = visibleNavShortcuts('viewer');
    expect(visible.some((shortcut) => shortcut.to === '/incident')).toBe(false);
    expect(visible.some((shortcut) => shortcut.to === '/audit')).toBe(false);
    expect(visible.some((shortcut) => shortcut.to === '/host-pools')).toBe(true);
  });

  it('excludes operator-only rows when role is null (auth still loading, or signed out)', () => {
    const visible = visibleNavShortcuts(null);
    expect(visible.some((shortcut) => shortcut.to === '/incident')).toBe(false);
    expect(visible.some((shortcut) => shortcut.to === '/audit')).toBe(false);
    expect(visible.some((shortcut) => shortcut.to === '/host-pools')).toBe(true);
  });
});
