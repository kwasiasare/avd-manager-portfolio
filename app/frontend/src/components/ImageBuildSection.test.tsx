import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImageBuildDetail } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const listImageBuilds = vi.fn();
const getImageBuild = vi.fn();
const startImageBuild = vi.fn();
const advanceImageBuild = vi.fn();
const cancelImageBuild = vi.fn();
const updateImageBuildChecklist = vi.fn();
const deleteImageBuildSnapshot = vi.fn();
vi.mock('../api/avd', () => ({
  listImageBuilds: (...args: unknown[]) => listImageBuilds(...args),
  getImageBuild: (...args: unknown[]) => getImageBuild(...args),
  startImageBuild: (...args: unknown[]) => startImageBuild(...args),
  advanceImageBuild: (...args: unknown[]) => advanceImageBuild(...args),
  cancelImageBuild: (...args: unknown[]) => cancelImageBuild(...args),
  updateImageBuildChecklist: (...args: unknown[]) => updateImageBuildChecklist(...args),
  deleteImageBuildSnapshot: (...args: unknown[]) => deleteImageBuildSnapshot(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: ImageBuildSection } = await import('./ImageBuildSection');

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'admin@contoso.example', roles: ['admin'], role: 'admin', ...overrides };
}

function doneBuild(overrides: Partial<ImageBuildDetail> = {}): ImageBuildDetail {
  return {
    buildId: 'build-1',
    version: '2.1.0',
    state: 'done',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    createdBy: 'admin@contoso.example',
    vmName: 'VM-IMG-AAAAAAAA',
    nicName: 'NIC-VM-IMG-AAAAAAAA',
    diskName: 'OSDISK-VM-IMG-AAAAAAAA',
    snapshotName: 'SNAP-WIN11-PRE-SYSPREP-2.1.0',
    checklist: {},
    steps: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue(authState());
  listImageBuilds.mockResolvedValue({ builds: [{ buildId: 'build-1', version: '2.1.0', state: 'done', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', createdBy: 'admin@contoso.example' }] });
});

async function selectBuild() {
  const user = userEvent.setup();
  renderWithProviders(<ImageBuildSection />);
  const viewButton = await screen.findByRole('button', { name: /^view$/i });
  await user.click(viewButton);
}

describe('ImageBuildSection — AM-53 pre-Sysprep snapshot row', () => {
  it('does not render the snapshot row for a build that has not reached done', async () => {
    getImageBuild.mockResolvedValue(doneBuild({ state: 'checklist_gate', snapshotStatus: undefined, snapshotDeletable: undefined }));
    await selectBuild();
    await waitFor(() => expect(getImageBuild).toHaveBeenCalled());
    expect(screen.queryByText(/pre-sysprep snapshot/i)).not.toBeInTheDocument();
  });

  it('shows the snapshot name + status badge, and an ENABLED delete button when the server says snapshotDeletable:true', async () => {
    getImageBuild.mockResolvedValue(doneBuild({ snapshotStatus: 'present', snapshotDeletable: true }));
    await selectBuild();

    expect(await screen.findByText('SNAP-WIN11-PRE-SYSPREP-2.1.0')).toBeInTheDocument();
    expect(screen.getByText('present')).toBeInTheDocument();
    const deleteButton = screen.getByRole('button', { name: /delete snapshot/i });
    expect(deleteButton).toBeEnabled();
  });

  it('DISABLES the delete button (never re-implementing the gate) when the server says snapshotDeletable:false', async () => {
    getImageBuild.mockResolvedValue(doneBuild({ snapshotStatus: 'present', snapshotDeletable: false, snapshotDeleteBlockedReason: 'no completed rollout found for this version' }));
    await selectBuild();

    const deleteButton = await screen.findByRole('button', { name: /delete snapshot/i });
    expect(deleteButton).toBeDisabled();
  });

  it('hides the delete action entirely once the snapshot is already deleted', async () => {
    getImageBuild.mockResolvedValue(doneBuild({ snapshotStatus: 'deleted', snapshotDeletable: false }));
    await selectBuild();

    expect(await screen.findByText('deleted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete snapshot/i })).not.toBeInTheDocument();
  });

  it('shows the submitted timestamp once a delete has been submitted', async () => {
    getImageBuild.mockResolvedValue(doneBuild({ snapshotStatus: 'deleted', snapshotDeletable: false, snapshotDeleteSubmittedAt: '2026-08-23T00:00:00.000Z' }));
    await selectBuild();

    expect(await screen.findByText(/delete submitted/i)).toBeInTheDocument();
  });
});
