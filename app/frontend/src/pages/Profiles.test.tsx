import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileVhd, ProfilesListResponse, RetiredProfileVhd } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getProfiles = vi.fn();
const resolveDuplicateContainer = vi.fn();
vi.mock('../api/avd', () => ({
  getProfiles: (...args: unknown[]) => getProfiles(...args),
  resetProfile: vi.fn(),
  restoreProfile: vi.fn(),
  deleteRetiredProfile: vi.fn(),
  resolveDuplicateContainer: (...args: unknown[]) => resolveDuplicateContainer(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: Profiles } = await import('./Profiles');

const RETIRED: RetiredProfileVhd = {
  id: 'jdoe::retired-1',
  folderName: 'jdoe',
  kind: 'directory',
  sid: undefined,
  userPrincipalName: 'jdoe@contoso.example',
  nameParseQuality: 'sid_username',
  retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233',
  originalFileName: 'Profile_jdoe.vhdx',
  sizeBytes: 1_000_000,
  sizeGb: 1,
  lastModified: undefined,
  retiredAt: '2026-08-16T14:02:33.000Z',
};

const RESPONSE: ProfilesListResponse = {
  storageAccountName: 'stcontosoprofiles',
  shareName: 'profiles',
  oversizedThresholdGb: 5,
  generatedAt: '2026-08-16T14:00:00.000Z',
  fileRest: { status: 'available' },
  partial: false,
  profiles: [],
  retired: [RETIRED],
  orphanDetection: { status: 'not-configured' },
  fallbackShareUsage: undefined,
};

const DUPLICATE_A: ProfileVhd = {
  id: 'S-1-5-21-1_dsmith::Profile_dsmith.vhd',
  folderName: 'S-1-5-21-1_dsmith',
  fileName: 'Profile_dsmith.vhd',
  kind: 'directory',
  sid: 'S-1-5-21-1',
  userPrincipalName: 'dsmith@contoso.example',
  nameParseQuality: 'sid_username',
  sizeBytes: 2_000_000_000,
  sizeGb: 2,
  lastModified: '2026-08-20T00:00:00.000Z',
  oversized: false,
  orphanStatus: 'not-orphan',
  orphanEvidence: 'Matched AVD-Users group membership by username ("dsmith").',
  locked: false,
  lockedBy: undefined,
  activeSiblingCount: 2,
  duplicateContainer: true,
};

const DUPLICATE_B: ProfileVhd = {
  ...DUPLICATE_A,
  id: 'S-1-5-21-1_dsmith::Profile_dsmith.VHDX',
  fileName: 'Profile_dsmith.VHDX',
  sizeBytes: 1_500_000_000,
  sizeGb: 1.5,
};

const RESPONSE_WITH_DUPLICATE: ProfilesListResponse = { ...RESPONSE, profiles: [DUPLICATE_A, DUPLICATE_B], retired: [] };

beforeEach(() => {
  useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'admin@contoso.example', roles: ['admin'], role: 'admin' });
  getProfiles.mockReset().mockResolvedValue(RESPONSE);
  resolveDuplicateContainer.mockReset().mockResolvedValue({ status: 'retired', folderName: DUPLICATE_A.folderName, fileName: DUPLICATE_A.fileName, retiredFileName: 'Profile_dsmith.vhd.retired-20260823-140233', correlationId: 'corr-1' });
});

describe('Profiles — retired-profile overflow menu (AM-31 item 40)', () => {
  it('collapses Restore/Delete into a single per-row overflow menu', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Profiles />);
    const row = (await screen.findByText('jdoe@contoso.example')).closest('tr')!;

    expect(within(row).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: /more actions for jdoe@contoso.example/i }));
    expect(await screen.findByRole('menuitem', { name: 'Restore' })).toBeInTheDocument();
    // Peer review MINOR 12 — the Delete item's accessible name now also
    // includes its secondaryContent destructive-warning text (Fluent folds
    // a MenuItem's secondaryContent into its computed name), so this match
    // is a prefix regex rather than the old bare "Delete".
    expect(screen.getByRole('menuitem', { name: /^Delete/ })).toBeInTheDocument();
  });

  it('opens the restore confirm dialog from the overflow menu', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Profiles />);
    const row = (await screen.findByText('jdoe@contoso.example')).closest('tr')!;

    await user.click(within(row).getByRole('button', { name: /more actions for jdoe@contoso.example/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));

    expect(await screen.findByText(/Restore jdoe@contoso.example\?/)).toBeInTheDocument();
  });
});

describe('Profiles — duplicate-container detection + guided resolve (AM-51)', () => {
  it('renders a "Duplicate container" badge for every row sharing a folder with more than one active file', async () => {
    getProfiles.mockResolvedValue(RESPONSE_WITH_DUPLICATE);
    renderWithProviders(<Profiles />);

    const badges = await screen.findAllByText('Duplicate container');
    expect(badges).toHaveLength(2);
  });

  it('does not render the badge, or the row action, for a non-duplicate row', async () => {
    renderWithProviders(<Profiles />);
    await screen.findByText('jdoe@contoso.example');
    expect(screen.queryByText('Duplicate container')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve duplicate…' })).not.toBeInTheDocument();
  });

  it('"Resolve duplicate…" is gated to admin — hidden for an operator', async () => {
    useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator' });
    getProfiles.mockResolvedValue(RESPONSE_WITH_DUPLICATE);
    renderWithProviders(<Profiles />);

    await screen.findAllByText('dsmith@contoso.example');
    expect(screen.queryByRole('button', { name: 'Resolve duplicate…' })).not.toBeInTheDocument();
  });

  it('opens the picker dialog listing both active siblings, then advances to the retire confirm dialog', async () => {
    const user = userEvent.setup();
    getProfiles.mockResolvedValue(RESPONSE_WITH_DUPLICATE);
    renderWithProviders(<Profiles />);

    const rows = await screen.findAllByText('dsmith@contoso.example');
    expect(rows).toHaveLength(2);
    const row = rows[0].closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Resolve duplicate…' }));

    const dialogHeading = await screen.findByRole('heading', { name: /Resolve duplicate containers/ });
    const dialog = dialogHeading.closest('[role="dialog"]') as HTMLElement;
    expect(within(dialog).getByText('Profile_dsmith.vhd')).toBeInTheDocument();
    expect(within(dialog).getByText('Profile_dsmith.VHDX')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/Retire "Profile_dsmith\.vhd"\?/)).toBeInTheDocument();
  });

  it('submits the retire choice, calling resolveDuplicateContainer with the chosen file and mode', async () => {
    const user = userEvent.setup();
    getProfiles.mockResolvedValue(RESPONSE_WITH_DUPLICATE);
    renderWithProviders(<Profiles />);

    const row = (await screen.findAllByText('dsmith@contoso.example'))[0].closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Resolve duplicate…' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    await screen.findByText(/Retire "Profile_dsmith\.vhd"\?/);
    await user.type(screen.getByPlaceholderText('Why is this needed?'), 'cleaning up duplicate from VolumeType misconfig');
    await user.click(screen.getByRole('button', { name: 'Retire this container' }));

    expect(resolveDuplicateContainer).toHaveBeenCalledWith('S-1-5-21-1_dsmith', {
      fileName: 'Profile_dsmith.vhd',
      mode: 'retire',
      reason: 'cleaning up duplicate from VolumeType misconfig',
    });
  });
});
