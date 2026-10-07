import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import DeltaBadge from './DeltaBadge';

describe('DeltaBadge', () => {
  it('renders nothing when there is no comparison value', () => {
    renderWithProviders(<DeltaBadge current={100} comparison={undefined} />);
    expect(screen.queryByText(/vs prior period/)).not.toBeInTheDocument();
  });

  it('renders nothing when the comparison is exactly 0 (undefined percentage change)', () => {
    renderWithProviders(<DeltaBadge current={100} comparison={0} />);
    expect(screen.queryByText(/vs prior period/)).not.toBeInTheDocument();
  });

  it('renders nothing when the comparison is negative (peer review NIT — would otherwise flip the up/down sign misleadingly)', () => {
    renderWithProviders(<DeltaBadge current={5} comparison={-10} />);
    expect(screen.queryByText(/vs prior period/)).not.toBeInTheDocument();
  });

  it('shows a "+" prefixed increase for a higher current value', () => {
    renderWithProviders(<DeltaBadge current={120} comparison={100} />);
    expect(screen.getByText('+20% vs prior period')).toBeInTheDocument();
  });

  it('shows a decrease without a "+" prefix for a lower current value', () => {
    renderWithProviders(<DeltaBadge current={80} comparison={100} />);
    expect(screen.getByText('-20% vs prior period')).toBeInTheDocument();
  });
});
