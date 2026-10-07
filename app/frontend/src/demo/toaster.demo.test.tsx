import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toast, ToastTitle } from '@fluentui/react-components';

vi.stubEnv('VITE_DEMO_MODE', 'true');

const { renderWithProviders } = await import('../test/renderWithProviders');
const { useAppToast } = await import('../lib/toaster');
const { markSimulated, clearSimulated, SIMULATED_TOAST_TEXT } = await import('./simulatedSignal');

function Probe({ simulated, title }: { simulated: boolean; title: string }) {
  const { dispatchToast } = useAppToast();
  return (
    <button
      type="button"
      onClick={() => {
        if (simulated) markSimulated();
        else clearSimulated();
        dispatchToast(
          <Toast>
            <ToastTitle>{title}</ToastTitle>
          </Toast>,
          { intent: 'success' },
        );
      }}
    >
      {title}-button
    </button>
  );
}

describe('demo toast suffix', () => {
  it('does not add the simulated line to ordinary toasts', async () => {
    renderWithProviders(<Probe simulated={false} title="Plain toast" />);
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Plain toast')).toBeInTheDocument();
    expect(screen.queryByText(SIMULATED_TOAST_TEXT)).not.toBeInTheDocument();
  });

  it('appends the simulated line right after a simulated mutation', async () => {
    renderWithProviders(<Probe simulated title="Drain enabled on avd-con-0" />);
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Drain enabled on avd-con-0')).toBeInTheDocument();
    expect(await screen.findByText(SIMULATED_TOAST_TEXT)).toBeInTheDocument();
  });

  it('consumes the signal: only the first toast after a simulated mutation carries the suffix (AM-60 review fix)', async () => {
    function ProbeTwice() {
      const { dispatchToast } = useAppToast();
      return (
        <button
          type="button"
          onClick={() => {
            markSimulated();
            dispatchToast(<Toast><ToastTitle>First toast</ToastTitle></Toast>, { intent: 'success' });
            dispatchToast(<Toast><ToastTitle>Second toast</ToastTitle></Toast>, { intent: 'success' });
          }}
        >
          twice
        </button>
      );
    }
    renderWithProviders(<ProbeTwice />);
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Second toast')).toBeInTheDocument();
    expect(screen.getAllByText(SIMULATED_TOAST_TEXT)).toHaveLength(1);
  });
});
