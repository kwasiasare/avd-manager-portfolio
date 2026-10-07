import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import DevPreviewBanner, { isDevPreviewHostname } from './DevPreviewBanner';

const ORIGINAL_LOCATION = window.location;

function setHostname(hostname: string) {
  Object.defineProperty(window, 'location', { value: { ...ORIGINAL_LOCATION, hostname }, writable: true, configurable: true });
}

describe('isDevPreviewHostname (pure) — AM-40 peer review MAJOR 4', () => {
  it('matches a named "-dev." preview hostname', () => {
    expect(isDevPreviewHostname('example-dev.7.azurestaticapps.net')).toBe(true);
  });

  it('does NOT match the production hostname', () => {
    expect(isDevPreviewHostname('example.7.azurestaticapps.net')).toBe(false);
  });

  it('does NOT match a PR-numbered ephemeral preview hostname (a different deployment type — see docs/app-registration.md §12.1)', () => {
    expect(isDevPreviewHostname('example-3.7.azurestaticapps.net')).toBe(false);
  });

  it('does NOT match localhost', () => {
    expect(isDevPreviewHostname('localhost')).toBe(false);
  });
});

describe('DevPreviewBanner — AM-40 peer review MAJOR 4', () => {
  afterEach(() => {
    Object.defineProperty(window, 'location', { value: ORIGINAL_LOCATION, writable: true, configurable: true });
  });

  it('renders nothing on the production hostname', () => {
    setHostname('example.7.azurestaticapps.net');
    render(<DevPreviewBanner />);
    expect(screen.queryByText(/DEV PREVIEW/i)).not.toBeInTheDocument();
  });

  it('renders nothing on localhost (local dev server)', () => {
    setHostname('localhost');
    render(<DevPreviewBanner />);
    expect(screen.queryByText(/DEV PREVIEW/i)).not.toBeInTheDocument();
  });

  it('renders a persistent, high-visibility warning on the named "-dev." preview hostname, naming the shared production backend and live estate', () => {
    setHostname('example-dev.7.azurestaticapps.net');
    render(<DevPreviewBanner />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('DEV PREVIEW')).toBeInTheDocument();
    expect(screen.getByText(/SAME production API/i)).toBeInTheDocument();
    expect(screen.getByText(/live Azure estate/i)).toBeInTheDocument();
    expect(screen.getByText(/not simulated/i)).toBeInTheDocument();
  });
});
