import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import ImpactPreview from './ImpactPreview';
import { MAX_IMPACT_LINES } from '../lib/impactPreview';

describe('ImpactPreview', () => {
  it('renders nothing when lines is empty', () => {
    renderWithProviders(<ImpactPreview lines={[]} />);
    expect(screen.queryByText('What this will do')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('renders the default heading and every line', () => {
    renderWithProviders(<ImpactPreview lines={["Ends alice@contoso.example's Active session on avd-con-0. Unsaved work may be lost."]} />);
    expect(screen.getByText('What this will do')).toBeInTheDocument();
    expect(screen.getByText(/Ends alice@contoso.example's Active session/)).toBeInTheDocument();
  });

  it('accepts a custom heading', () => {
    renderWithProviders(<ImpactPreview lines={['Some line.']} heading="Custom heading" />);
    expect(screen.getByText('Custom heading')).toBeInTheDocument();
    expect(screen.queryByText('What this will do')).not.toBeInTheDocument();
  });

  it('treats a plain string line as info-toned (no warning icon, no warning styling)', () => {
    renderWithProviders(<ImpactPreview lines={['Plain info line.']} />);
    const line = screen.getByText(/Plain info line\./).closest('li')!;
    expect(line.querySelector('svg')).not.toBeInTheDocument();
  });

  it('renders a warning-toned line with its warning icon and a visually-hidden "Warning: " prefix', () => {
    renderWithProviders(<ImpactPreview lines={[{ text: 'Careful — this is risky.', tone: 'warning' }]} />);
    const line = screen.getByText(/Careful — this is risky\./).closest('li')!;
    expect(line.querySelector('svg')).toBeInTheDocument();
    // AM-33 peer review (Opus, NIT): a warning line's icon is aria-hidden,
    // so a screen-reader user needs the "Warning: " prefix (visually
    // hidden, not a redundant visible label) to hear the line is a warning
    // at all.
    expect(line).toHaveTextContent('Warning: Careful — this is risky.');
  });

  it('does not add a "Warning: " prefix to info-toned lines', () => {
    renderWithProviders(<ImpactPreview lines={[{ text: 'Just FYI.', tone: 'info' }]} />);
    const line = screen.getByText('Just FYI.').closest('li')!;
    expect(line).not.toHaveTextContent('Warning:');
  });

  it('renders no stray leading space before an info line\'s text (no icon precedes it)', () => {
    renderWithProviders(<ImpactPreview lines={['No icon here.']} />);
    const line = screen.getByText('No icon here.').closest('li')!;
    expect(line.textContent).toBe('No icon here.');
  });

  it('renders both info and warning lines together, each with correct tone', () => {
    renderWithProviders(
      <ImpactPreview
        lines={[
          { text: 'Will end 2 disconnected sessions (alice@x, bob@x).', tone: 'info' },
          { text: '1 session disconnected less than 10 minutes ago — may be an active user switching networks.', tone: 'warning' },
        ]}
      />,
    );
    const infoLine = screen.getByText(/Will end 2 disconnected sessions/).closest('li')!;
    const warningLine = screen.getByText(/may be an active user switching networks/).closest('li')!;
    expect(infoLine.querySelector('svg')).not.toBeInTheDocument();
    expect(warningLine.querySelector('svg')).toBeInTheDocument();
  });

  it('exposes list/listitem roles (a flex display strips the implicit ones in Safari/VoiceOver) and links the heading via aria-labelledby', () => {
    renderWithProviders(<ImpactPreview lines={['One line.']} />);
    const list = screen.getByRole('list');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    const heading = screen.getByText('What this will do');
    expect(list).toHaveAttribute('aria-labelledby', heading.id);
    expect(heading.id).toBeTruthy();
  });

  it('appends a "+N more" line instead of silently truncating past MAX_IMPACT_LINES', () => {
    const lines = Array.from({ length: MAX_IMPACT_LINES + 3 }, (_, i) => `Line ${i}`);
    renderWithProviders(<ImpactPreview lines={lines} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(MAX_IMPACT_LINES);
    expect(screen.getByText('+4 more')).toBeInTheDocument();
    // The first MAX_IMPACT_LINES - 1 original lines are still shown verbatim, not swallowed by the fold.
    expect(screen.getByText('Line 0')).toBeInTheDocument();
    expect(screen.getByText(`Line ${MAX_IMPACT_LINES - 2}`)).toBeInTheDocument();
  });
});
