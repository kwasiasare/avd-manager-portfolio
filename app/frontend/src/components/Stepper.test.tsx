import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import Stepper, { type StepperStep } from './Stepper';

const BASE_STEPS: StepperStep[] = [
  { id: 'a', label: 'Step A', state: 'done' },
  { id: 'b', label: 'Step B', state: 'current' },
  { id: 'c', label: 'Step C', state: 'upcoming' },
];

describe('Stepper', () => {
  it('renders every step label in order', () => {
    renderWithProviders(<Stepper steps={BASE_STEPS} ariaLabel="Test progress" />);
    const list = screen.getByRole('list', { name: 'Test progress' });
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Step A');
    expect(items[1]).toHaveTextContent('Step B');
    expect(items[2]).toHaveTextContent('Step C');
  });

  it('marks exactly the current step with aria-current="step"', () => {
    renderWithProviders(<Stepper steps={BASE_STEPS} ariaLabel="Test progress" />);
    const current = screen.getByText('Step B').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Step A').closest('li')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Step C').closest('li')).not.toHaveAttribute('aria-current');
  });

  it('shows live elapsed time for the current step when startedAt is set', () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    renderWithProviders(<Stepper steps={[{ id: 'a', label: 'Running step', state: 'current', startedAt }]} ariaLabel="Test progress" />);
    expect(screen.getByText('1m elapsed')).toBeInTheDocument();
  });

  it('does not show elapsed time for a done or upcoming step even if startedAt is set', () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    renderWithProviders(
      <Stepper
        steps={[
          { id: 'a', label: 'Finished step', state: 'done', startedAt },
          { id: 'b', label: 'Not started step', state: 'upcoming', startedAt },
        ]}
        ariaLabel="Test progress"
      />,
    );
    expect(screen.queryByText(/elapsed/)).not.toBeInTheDocument();
  });

  it('renders an optional duration hint next to the label', () => {
    renderWithProviders(<Stepper steps={[{ id: 'a', label: 'Step A', state: 'upcoming', hint: '10 min' }]} ariaLabel="Test progress" />);
    expect(screen.getByText('typically ~10 min')).toBeInTheDocument();
  });

  it('renders an indeterminate progress bar for an in-flight step', () => {
    renderWithProviders(<Stepper steps={[{ id: 'a', label: 'Working', state: 'current', inFlight: true }]} ariaLabel="Test progress" />);
    expect(screen.getByRole('progressbar', { name: 'Working in progress' })).toBeInTheDocument();
  });

  it('does not render a progress bar when inFlight is not set', () => {
    renderWithProviders(<Stepper steps={BASE_STEPS} ariaLabel="Test progress" />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('renders step error text when provided', () => {
    renderWithProviders(<Stepper steps={[{ id: 'a', label: 'Failed step', state: 'current', tone: 'error', statusLabel: 'Failed', error: 'Something went wrong' }]} ariaLabel="Test progress" />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('supports vertical orientation without changing step content', () => {
    renderWithProviders(<Stepper steps={BASE_STEPS} orientation="vertical" ariaLabel="Test progress" />);
    expect(screen.getByRole('list', { name: 'Test progress' })).toBeInTheDocument();
    expect(screen.getByText('Step A')).toBeInTheDocument();
  });
});
