import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import StatTile from './StatTile';

describe('StatTile', () => {
  it('renders the title and delegates data rendering to children', () => {
    renderWithProviders(
      <StatTile title="Sessions" loading={false} error={undefined} data={{ used: 3 }}>
        {(data) => <span>{data.used} used</span>}
      </StatTile>,
    );
    expect(screen.getByRole('heading', { name: 'Sessions', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('3 used')).toBeInTheDocument();
  });

  it('shows the AsyncState "stat" skeleton while loading', () => {
    renderWithProviders(
      <StatTile title="Cost" loading error={undefined} data={undefined}>
        {() => <span>should not render</span>}
      </StatTile>,
    );
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('should not render')).not.toBeInTheDocument();
  });

  it('shows the error state when there is no data at all', () => {
    renderWithProviders(
      <StatTile title="Image version" loading={false} error={new Error('boom')} data={undefined}>
        {() => <span>should not render</span>}
      </StatTile>,
    );
    expect(screen.getByText("Couldn't load this data")).toBeInTheDocument();
  });

  it('renders no CardFooter/link when footerLink is omitted', () => {
    renderWithProviders(
      <StatTile title="Sessions" loading={false} error={undefined} data={{}}>
        {() => <span>content</span>}
      </StatTile>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders a CardFooter AppLink when footerLink is given', () => {
    renderWithProviders(
      <StatTile title="Scaling phase" loading={false} error={undefined} data={{}} footerLink={{ to: '/scaling', label: 'View scaling →' }}>
        {() => <span>content</span>}
      </StatTile>,
    );
    const link = screen.getByRole('link', { name: 'View scaling →' });
    expect(link).toHaveAttribute('href', '/scaling');
  });
});
