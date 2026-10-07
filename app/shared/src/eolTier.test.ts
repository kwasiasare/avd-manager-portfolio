import { describe, expect, it } from 'vitest';
import { eolTier } from './eolTier';

describe('eolTier', () => {
  it('returns "unknown" when daysUntilEol is undefined', () => {
    expect(eolTier(undefined)).toBe('unknown');
  });

  it('returns "critical" for a negative daysUntilEol (already past EOL)', () => {
    expect(eolTier(-1)).toBe('critical');
    expect(eolTier(-365)).toBe('critical');
  });

  it('returns "critical" for 0 and any value below the 30-day threshold', () => {
    expect(eolTier(0)).toBe('critical');
    expect(eolTier(1)).toBe('critical');
    expect(eolTier(29)).toBe('critical');
  });

  it('returns "warning" at the 30-day boundary and below the 90-day threshold', () => {
    expect(eolTier(30)).toBe('warning');
    expect(eolTier(89)).toBe('warning');
  });

  it('returns "ok" at the 90-day boundary and beyond', () => {
    expect(eolTier(90)).toBe('ok');
    expect(eolTier(365)).toBe('ok');
  });
});
