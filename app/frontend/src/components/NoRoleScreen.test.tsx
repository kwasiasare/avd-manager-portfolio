import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import NoRoleScreen from './NoRoleScreen';

/** Peer review (Opus, MAJOR item 3): NoRoleScreen's own copy instructs signing out — it needs a way to actually do that. */
describe('NoRoleScreen — Sign out (peer review item 3)', () => {
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('navigates to /.auth/logout when Sign out is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NoRoleScreen userDetails="user@example.com" />);

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(assignSpy).toHaveBeenCalledWith('/.auth/logout');
  });
});
