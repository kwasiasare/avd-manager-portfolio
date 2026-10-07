import { describe, expect, it } from 'vitest';
import { formatOnOff } from './format';

describe('formatOnOff — AM-38', () => {
  it('renders "On" for true', () => {
    expect(formatOnOff(true)).toBe('On');
  });

  it('renders "Off" for false', () => {
    expect(formatOnOff(false)).toBe('Off');
  });

  it('renders "—" (never "Off") for undefined — an unknown value must not read as a definite disabled state', () => {
    expect(formatOnOff(undefined)).toBe('—');
  });
});
