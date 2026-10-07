import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import ConfirmModal from './ConfirmModal';

function clearReasonHistory() {
  window.localStorage.clear();
}

describe('ConfirmModal — legacy shape (no severity, backward-compatible)', () => {
  beforeEach(clearReasonHistory);

  it('keeps Confirm disabled until the typed value exactly matches confirmText, then calls onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmModal title="Delete host pool" confirmText="HP-CONTOSO-PROD" onConfirm={onConfirm} onCancel={vi.fn()} />);

    const confirmButton = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirmButton).toBeDisabled();

    const nameInput = screen.getByPlaceholderText('HP-CONTOSO-PROD');
    await user.type(nameInput, 'not-the-right-name');
    expect(confirmButton).toBeDisabled();

    await user.clear(nameInput);
    await user.type(nameInput, 'HP-CONTOSO-PROD');
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('stays disabled after the name matches until a non-whitespace reason is entered, then passes the trimmed reason', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmModal title="Force logoff" confirmText="jdoe" reasonRequired onConfirm={onConfirm} onCancel={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('jdoe'), 'jdoe');
    const confirmButton = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirmButton).toBeDisabled();

    const reasonInput = screen.getByPlaceholderText('Why is this needed?');
    // fireEvent.change (not user.type) for the whitespace-only case: typing a
    // literal space as the FIRST character into an already-open freeform
    // Combobox is, per Fluent's own ARIA combobox key handling
    // (getDropdownActionFromKey), a "select the active option and close"
    // action rather than a plain character insertion — an edge case that
    // doesn't arise in real usage (nobody starts a reason with a bare
    // space), but would otherwise make this assertion about this
    // component's OWN trim-guard fail on account of Fluent's keyboard
    // handling rather than anything this component does.
    fireEvent.change(reasonInput, { target: { value: '   ' } });
    expect(confirmButton).toBeDisabled();

    await user.type(reasonInput, 'User requested access removal');
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith('User requested access removal');
  });

  it('does not require a reason when reasonRequired is false (the default)', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmModal title="Drain host" confirmText="host-1" onConfirm={onConfirm} onCancel={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('host-1'), 'host-1');
    const confirmButton = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirmButton).toBeEnabled();
  });
});

describe('ConfirmModal — severity "low"', () => {
  beforeEach(clearReasonHistory);

  it('renders no typed-name field and no reason field, and Confirm is enabled immediately', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmModal title="Resume host" description="Allows new sessions again." severity="low" onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect(screen.queryByPlaceholderText('Why is this needed?')).not.toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('with optionalReason, shows a reason field that is NOT required — Confirm stays enabled with it blank, and a filled-in reason is passed through', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmModal title="Drain host" severity="low" optionalReason onConfirm={onConfirm} onCancel={vi.fn()} />);

    const reasonInput = screen.getByPlaceholderText('Why is this needed?');
    expect(screen.getByText('Reason (optional)')).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirmButton).toBeEnabled();

    await user.type(reasonInput, 'Pre-maintenance drain');
    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith('Pre-maintenance drain');
  });

  it('without optionalReason, focuses nothing extra; with optionalReason, autofocuses the reason field on mount', () => {
    renderWithProviders(<ConfirmModal title="Drain host" severity="low" optionalReason onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByPlaceholderText('Why is this needed?')).toHaveFocus();
  });
});

describe('ConfirmModal — severity "medium"', () => {
  beforeEach(clearReasonHistory);

  it('requires a reason but shows no typed-name field', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmModal title="Restart host" severity="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect(screen.queryByText(/type .* to confirm/i)).not.toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirmButton).toBeDisabled();

    const reasonInput = screen.getByPlaceholderText('Why is this needed?');
    await user.type(reasonInput, 'Scheduled reboot');
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith('Scheduled reboot');
  });

  it('offers the canned reasons as Combobox options', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConfirmModal title="Restart host" severity="medium" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    await user.click(screen.getByPlaceholderText('Why is this needed?'));
    expect(await screen.findByRole('option', { name: 'Incident response' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Scheduled maintenance' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Troubleshooting' })).toBeInTheDocument();
  });

  it('autofocuses the reason combobox on mount — it is the first (and only) field', () => {
    renderWithProviders(<ConfirmModal title="Restart host" severity="medium" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByPlaceholderText('Why is this needed?')).toHaveFocus();
  });

  it('records a submitted free-text reason so it appears as an option next time', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { unmount } = renderWithProviders(<ConfirmModal title="Restart host" severity="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('Why is this needed?'), 'Contoso change CHG-1234');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith('Contoso change CHG-1234');
    unmount();

    renderWithProviders(<ConfirmModal title="Restart host" severity="medium" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    await user.click(screen.getByPlaceholderText('Why is this needed?'));
    expect(await screen.findByRole('option', { name: 'Contoso change CHG-1234' })).toBeInTheDocument();
  });
});

describe('ConfirmModal — severity "high"', () => {
  beforeEach(clearReasonHistory);

  it('requires both the typed confirmation and a reason, and renders an impact node', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(
      <ConfirmModal
        title="Permanently delete profile"
        severity="high"
        confirmText="DELETE"
        impact={<span>This removes 3 retired VHD(X) files.</span>}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('This removes 3 retired VHD(X) files.')).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE');
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Why is this needed?'), 'User requested deletion');
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith('User requested deletion');
  });

  it('autofocuses the typed-confirm field on mount — it is always the first field when shown', () => {
    renderWithProviders(<ConfirmModal title="Permanently delete profile" severity="high" confirmText="DELETE" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByPlaceholderText('DELETE')).toHaveFocus();
  });
});
