import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from '@fluentui/react-components';
import { renderWithProviders } from '../test/renderWithProviders';
import StatusBadge from './StatusBadge';

/**
 * AM-13 peer review regression (item 5): before StatusBadge was wrapped in
 * forwardRef, Fluent's <Tooltip> could not attach a ref to it — a Tooltip
 * wrapping a plain function component silently drops the ref (React dev-mode
 * warning only, no thrown error), so every `<Tooltip><StatusBadge /></Tooltip>`
 * in this app (e.g. Dashboard.tsx's stale-heartbeat warning) never actually
 * positioned or described the tooltip correctly. This test exercises the
 * real user-facing symptom — hovering the badge must actually open the
 * tooltip — rather than asserting on forwardRef as an implementation detail,
 * so it would have failed against the pre-fix component.
 */
describe('StatusBadge', () => {
  it('forwards its ref so a wrapping Tooltip opens on hover (AM-13 peer review regression)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Tooltip content="No heartbeat in over 30 minutes" relationship="label">
        <StatusBadge label="Available" tone="ok" />
      </Tooltip>,
    );

    await user.hover(screen.getByText('Available'));

    expect(await screen.findByText('No heartbeat in over 30 minutes')).toBeInTheDocument();
  });

  it('renders a bare badge correctly without a wrapping Tooltip', () => {
    renderWithProviders(<StatusBadge label="Unavailable" tone="error" />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('defaults to the "info" tone when none is given', () => {
    renderWithProviders(<StatusBadge label="LogOff" />);
    expect(screen.getByText('LogOff')).toBeInTheDocument();
  });

  // AM-29 item 16: 'pending' and 'unknown' were added alongside the
  // ok/warning/error/info set, each with its own Fluent appearance (subtle /
  // outline respectively, not the default tint) — see StatusBadge.tsx's
  // TONE_TO_APPEARANCE map. Rendering with each of the six tones without a
  // wrapping Tooltip is enough to catch a typo'd/missing map entry (Record<>
  // would otherwise let TypeScript catch it, but this also guards the
  // runtime Badge `appearance`/`color` values Fluent actually accepts).
  it.each(['ok', 'warning', 'error', 'info', 'pending', 'unknown'] as const)('renders every StatusTone ("%s") without throwing', (tone) => {
    renderWithProviders(<StatusBadge label={`tone-${tone}`} tone={tone} />);
    expect(screen.getByText(`tone-${tone}`)).toBeInTheDocument();
  });

  it('gives "pending" a distinct (subtle) color from the other tinted tones', () => {
    renderWithProviders(
      <>
        <StatusBadge label="ok-tone" tone="ok" />
        <StatusBadge label="pending-tone" tone="pending" />
      </>,
    );
    const okBadge = screen.getByText('ok-tone');
    const pendingBadge = screen.getByText('pending-tone');
    // Both use Fluent's 'tint' appearance, but a different `color` — some
    // class in Fluent's generated set differs between them, even though the
    // exact class names are build-time hashes we don't assert on literally.
    expect(okBadge.className).not.toBe(pendingBadge.className);
  });

  it('gives "unknown" a distinct (outline) appearance from the tinted tones', () => {
    renderWithProviders(
      <>
        <StatusBadge label="ok-tone" tone="ok" />
        <StatusBadge label="unknown-tone" tone="unknown" />
      </>,
    );
    expect(screen.getByText('ok-tone').className).not.toBe(screen.getByText('unknown-tone').className);
  });
});
