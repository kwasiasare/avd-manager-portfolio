import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import DemoBanner from './DemoBanner';
import { DEMO_ROLE_STORAGE_KEY, getDemoRole, resetDemoRoleCache } from '../demo/identity';
import { getDemoState } from '../demo/state';

describe('DemoBanner', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetDemoRoleCache();
  });

  it('explains the demo and offers the three roles', () => {
    renderWithProviders(<DemoBanner />);
    expect(screen.getByText(/fictional Contoso estate, in-memory data/)).toBeInTheDocument();
    expect(screen.getByText(/Reversible actions are simulated; destructive ones are disabled/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Viewer' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Operator' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Admin' })).toBeChecked();
  });

  it('switches and persists the role', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DemoBanner />);
    await user.click(screen.getByRole('radio', { name: 'Viewer' }));
    expect(getDemoRole()).toBe('viewer');
    expect(window.sessionStorage.getItem(DEMO_ROLE_STORAGE_KEY)).toBe('viewer');
    expect(screen.getByRole('radio', { name: 'Viewer' })).toBeChecked();
  });

  it('resets demo data and reloads', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const before = getDemoState();
    renderWithProviders(<DemoBanner />);
    await user.click(screen.getByRole('button', { name: 'Reset demo data' }));
    expect(getDemoState()).not.toBe(before);
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
