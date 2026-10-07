import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScalingPlanDetail } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getCurrentScalingPlan = vi.fn();
const getEmergencyOverrideStatus = vi.fn();
const getScalingHistory = vi.fn();
vi.mock('../api/avd', () => ({
  getCurrentScalingPlan: (...args: unknown[]) => getCurrentScalingPlan(...args),
  getEmergencyOverrideStatus: (...args: unknown[]) => getEmergencyOverrideStatus(...args),
  getScalingHistory: (...args: unknown[]) => getScalingHistory(...args),
  activateEmergencyOverride: vi.fn(),
  cancelEmergencyOverride: vi.fn(),
  createScalingSchedule: vi.fn(),
  deleteScalingSchedule: vi.fn(),
  updateScalingSchedule: vi.fn(),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: Scaling } = await import('./Scaling');

const PLAN: ScalingPlanDetail = {
  id: 'p1',
  name: 'SCALE-CONTOSO-PROD',
  hostPoolName: 'HP-CONTOSO-PROD',
  timeZone: 'Eastern Standard Time',
  enabled: true,
  schedules: [
    {
      name: 'AllDays',
      daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      rampUpStartTime: { hour: 7, minute: 0 },
      peakStartTime: { hour: 9, minute: 0 },
      rampDownStartTime: { hour: 18, minute: 0 },
      offPeakStartTime: { hour: 20, minute: 0 },
    },
  ],
};

beforeEach(() => {
  useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator' });
  getCurrentScalingPlan.mockReset().mockResolvedValue(PLAN);
  getEmergencyOverrideStatus.mockReset().mockResolvedValue({ active: false });
  getScalingHistory.mockReset().mockResolvedValue({ entries: [] });
});

describe('Scaling (AM-31 item 32b)', () => {
  it('renders the page title, plan details, and schedule timeline', async () => {
    renderWithProviders(<Scaling />);
    expect(screen.getByRole('heading', { level: 1, name: 'Scaling' })).toBeInTheDocument();
    expect(await screen.findByText('SCALE-CONTOSO-PROD')).toBeInTheDocument();
    expect(screen.getByText('AllDays')).toBeInTheDocument();
    // AM-31 item 42 — legend uses the shared PHASE_LABEL wording.
    expect(screen.getByText('Ramp-up 07:00')).toBeInTheDocument();
    expect(screen.getByText('Peak 09:00')).toBeInTheDocument();
  });

  it('opens the Edit schedule dialog for a schedule', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Scaling />);
    await screen.findByText('AllDays');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('Edit schedule — AllDays')).toBeInTheDocument();
  });
});

describe('Scaling — schedule-delete ImpactPreview panel (AM-33 MAJOR 4 integration coverage)', () => {
  it('renders the ImpactPreview warning lines above the confirm gate when deleting the only schedule leaves days uncovered', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Scaling />);
    await screen.findByText('AllDays');

    // PLAN's one schedule only covers Monday-Friday — deleting it (the only
    // schedule) leaves every day, including the weekend, uncovered.
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Delete schedule "AllDays"?')).toBeInTheDocument();
    expect(screen.getByText('What this will do')).toBeInTheDocument();
    // AllDays is the PLAN's only schedule, so deleting it leaves every day
    // uncovered (not just the weekend it didn't already cover) —
    // KNOWN_DAY_NAMES orders the week Sunday-first (see @avdmgr/shared's
    // scalingPhase.ts), and the uncovered-days list follows that order.
    expect(
      screen.getByText('Removes the AllDays schedule. Days left uncovered: Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/session hosts on those days may be deallocated/)).toBeInTheDocument();
    // MAJOR 5: the accessible one-line description survives alongside the panel.
    expect(screen.getByText('Removes this schedule from the scaling plan. This cannot be undone.')).toBeInTheDocument();

    // severity 'medium': a reason is required, no typed name. Scoped to the
    // dialog — the schedule card's own "Delete" button is still rendered
    // behind the (still-open) modal.
    const dialog = screen.getByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirmButton).toBeDisabled();
  });
});
