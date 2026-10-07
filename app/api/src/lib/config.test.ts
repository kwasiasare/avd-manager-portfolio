import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig } from './config';

/**
 * AM-15 (M7) sweep: config.ts had two numeric env reads
 * (`expectedPrivateEndpointCount`, `imageBuild.abandonmentWarningHours`)
 * that used raw `Number(readEnv(...))` instead of the NaN-guarded
 * `readNumberEnv` helper every other numeric setting in this file already
 * goes through — a present-but-non-numeric app setting would have
 * propagated `NaN` into downstream comparisons instead of falling back to
 * the documented default. `readNumberEnv` itself is a private, unexported
 * function, so these tests exercise it indirectly through `getConfig()`'s
 * public surface, same as every other config field would be tested.
 */
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getConfig — NaN-guarded numeric env reads', () => {
  it('governance.expectedPrivateEndpointCount falls back to the documented default (5) when unset', () => {
    delete process.env.EXPECTED_PRIVATE_ENDPOINT_COUNT;
    expect(getConfig().governance.expectedPrivateEndpointCount).toBe(5);
  });

  it('governance.expectedPrivateEndpointCount falls back to 5 (not NaN) when the app setting is present but not a number', () => {
    process.env.EXPECTED_PRIVATE_ENDPOINT_COUNT = 'not-a-number';
    const value = getConfig().governance.expectedPrivateEndpointCount;
    expect(Number.isNaN(value)).toBe(false);
    expect(value).toBe(5);
  });

  it('governance.expectedPrivateEndpointCount parses a valid override', () => {
    process.env.EXPECTED_PRIVATE_ENDPOINT_COUNT = '7';
    expect(getConfig().governance.expectedPrivateEndpointCount).toBe(7);
  });

  it('imageBuild.abandonmentWarningHours falls back to the documented default (24) when unset', () => {
    delete process.env.IMAGE_BUILD_ABANDONMENT_HOURS;
    expect(getConfig().imageBuild.abandonmentWarningHours).toBe(24);
  });

  it('imageBuild.abandonmentWarningHours falls back to 24 (not NaN) when the app setting is present but not a number', () => {
    process.env.IMAGE_BUILD_ABANDONMENT_HOURS = 'garbage';
    const value = getConfig().imageBuild.abandonmentWarningHours;
    expect(Number.isNaN(value)).toBe(false);
    expect(value).toBe(24);
  });

  it('imageBuild.abandonmentWarningHours parses a valid override', () => {
    process.env.IMAGE_BUILD_ABANDONMENT_HOURS = '48';
    expect(getConfig().imageBuild.abandonmentWarningHours).toBe(48);
  });
});
