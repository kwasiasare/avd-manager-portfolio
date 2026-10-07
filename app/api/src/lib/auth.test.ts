import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { getClientPrincipal, requireMinimumRole, requireRole, verifyBackendSecret } from './auth';

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
}

function makeRequest(
  headers: Record<string, string> = {},
  url = 'https://func-example.azurewebsites.net/api/v1/hostpools',
): HttpRequest {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url,
    headers: {
      get: (name: string) => lower.get(name.toLowerCase()) ?? null,
    },
  } as unknown as HttpRequest;
}

function makeContext(): FakeContext {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  return {
    warn: (...args: unknown[]) => {
      warnings.push(args.join(' '));
    },
    error: (...args: unknown[]) => {
      errors.push(args);
    },
    log: () => {},
    warnings,
    errors,
  } as unknown as FakeContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SWA_BACKEND_SECRET = 'test-shared-secret';
  delete process.env.NODE_ENV;
  delete process.env.ALLOW_INSECURE_LOCAL_AUTH;
  // REQUIRE_BACKEND_SECRET unset by default — matches the real deployed
  // default (see auth.ts#verifyBackendSecret's doc comment: SWA's
  // linked-backend forwarding has no sender for a custom header, so the
  // check is off unless explicitly turned on).
  delete process.env.REQUIRE_BACKEND_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getClientPrincipal', () => {
  it('returns null when the header is missing', () => {
    expect(getClientPrincipal(makeRequest())).toBeNull();
  });

  it('returns null when the header is not valid base64/JSON', () => {
    const header = Buffer.from('this is not json', 'utf-8').toString('base64');
    expect(getClientPrincipal(makeRequest({ 'x-ms-client-principal': header }))).toBeNull();
  });

  it('returns null when the decoded JSON is not an object', () => {
    const header = Buffer.from('null', 'utf-8').toString('base64');
    expect(getClientPrincipal(makeRequest({ 'x-ms-client-principal': header }))).toBeNull();
  });

  it('returns null when userRoles is missing', () => {
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'user@example.com' });
    expect(getClientPrincipal(makeRequest({ 'x-ms-client-principal': header }))).toBeNull();
  });

  it('returns the parsed principal when the header is well-formed', () => {
    const header = encodePrincipal({
      identityProvider: 'aad',
      userId: 'u1',
      userDetails: 'user@example.com',
      userRoles: ['authenticated', 'viewer'],
    });
    const principal = getClientPrincipal(makeRequest({ 'x-ms-client-principal': header }));
    expect(principal).toEqual({
      identityProvider: 'aad',
      userId: 'u1',
      userDetails: 'user@example.com',
      userRoles: ['authenticated', 'viewer'],
    });
  });
});

describe('verifyBackendSecret — REQUIRE_BACKEND_SECRET unset (default, matches real deployment)', () => {
  it('returns true with no header at all', () => {
    expect(verifyBackendSecret(makeRequest())).toBe(true);
  });

  it('returns true even with a header that does not match SWA_BACKEND_SECRET', () => {
    expect(verifyBackendSecret(makeRequest({ 'x-swa-backend-secret': 'wrong' }))).toBe(true);
  });

  it('returns true even when SWA_BACKEND_SECRET itself is unset', () => {
    delete process.env.SWA_BACKEND_SECRET;
    expect(verifyBackendSecret(makeRequest())).toBe(true);
  });
});

describe('verifyBackendSecret — REQUIRE_BACKEND_SECRET=true (opt-in, for a future sender)', () => {
  beforeEach(() => {
    process.env.REQUIRE_BACKEND_SECRET = 'true';
  });

  it('rejects when no header is sent', () => {
    expect(verifyBackendSecret(makeRequest())).toBe(false);
  });

  it('rejects when the header does not match SWA_BACKEND_SECRET', () => {
    expect(verifyBackendSecret(makeRequest({ 'x-swa-backend-secret': 'wrong' }))).toBe(false);
  });

  it('accepts when the header matches SWA_BACKEND_SECRET', () => {
    expect(verifyBackendSecret(makeRequest({ 'x-swa-backend-secret': 'test-shared-secret' }))).toBe(true);
  });

  it('fails closed when SWA_BACKEND_SECRET is unset, even with NODE_ENV=production', () => {
    delete process.env.SWA_BACKEND_SECRET;
    process.env.NODE_ENV = 'production';
    expect(verifyBackendSecret(makeRequest({ 'x-swa-backend-secret': 'anything' }))).toBe(false);
  });

  it('fails closed when SWA_BACKEND_SECRET is unset and NODE_ENV=development but opt-in flag is missing', () => {
    delete process.env.SWA_BACKEND_SECRET;
    process.env.NODE_ENV = 'development';
    expect(verifyBackendSecret(makeRequest())).toBe(false);
  });

  it('only bypasses when SWA_BACKEND_SECRET is unset AND NODE_ENV=development AND ALLOW_INSECURE_LOCAL_AUTH=true', () => {
    delete process.env.SWA_BACKEND_SECRET;
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_INSECURE_LOCAL_AUTH = 'true';
    expect(verifyBackendSecret(makeRequest())).toBe(true);
  });
});

describe('requireRole — REQUIRE_BACKEND_SECRET unset (default, matches real deployment)', () => {
  it('allows (ok:true) with a valid principal/role and NO backend-secret header at all — the real SWA rolesSource / linked-backend shape', () => {
    const context = makeContext();
    const header = encodePrincipal({
      identityProvider: 'aad',
      userId: 'u2',
      userDetails: 'operator@example.com',
      userRoles: ['authenticated', 'operator'],
    });
    const result = requireRole(makeRequest({ 'x-ms-client-principal': header }), ['operator', 'admin'], context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.userId).toBe('u2');
    }
    expect(context.warnings).toHaveLength(0);
  });

  it('still denies (401) and logs when the client principal is missing', () => {
    const context = makeContext();
    const result = requireRole(makeRequest(), ['viewer', 'operator', 'admin'], context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
    expect(context.warnings.some((w) => w.includes('principal=anonymous'))).toBe(true);
  });

  it('still denies (403) and logs when the principal lacks the required role', () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'u', userRoles: ['viewer'] });
    const result = requireRole(makeRequest({ 'x-ms-client-principal': header }), ['admin'], context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
    expect(context.warnings.some((w) => w.includes('principal=u1') && w.includes('insufficient role'))).toBe(true);
  });

  it('still normalizes role comparison case-insensitively', () => {
    const context = makeContext();
    const header = encodePrincipal({
      identityProvider: 'aad',
      userId: 'u3',
      userDetails: 'admin@example.com',
      userRoles: ['Admin'],
    });
    const result = requireRole(makeRequest({ 'x-ms-client-principal': header }), ['admin'], context);

    expect(result.ok).toBe(true);
  });
});

describe('requireRole — REQUIRE_BACKEND_SECRET=true (opt-in, for a future sender)', () => {
  beforeEach(() => {
    process.env.REQUIRE_BACKEND_SECRET = 'true';
  });

  const validSecretHeaders = { 'x-swa-backend-secret': 'test-shared-secret' };

  it('denies (401) and logs when the backend secret is missing, before even checking the principal', () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'u', userRoles: ['admin'] });
    const result = requireRole(makeRequest({ 'x-ms-client-principal': header }), ['admin'], context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
    expect(context.warnings.some((w) => w.includes('backend secret'))).toBe(true);
  });

  it('denies (401) and logs when the client principal is missing', () => {
    const context = makeContext();
    const result = requireRole(makeRequest(validSecretHeaders), ['viewer', 'operator', 'admin'], context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
    expect(context.warnings.some((w) => w.includes('principal=anonymous'))).toBe(true);
  });

  it('denies (403) and logs when the principal lacks the required role', () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'u', userRoles: ['viewer'] });
    const result = requireRole(makeRequest({ ...validSecretHeaders, 'x-ms-client-principal': header }), ['admin'], context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
    expect(context.warnings.some((w) => w.includes('principal=u1') && w.includes('insufficient role'))).toBe(true);
  });

  it('allows (ok:true) when the principal holds one of the required roles', () => {
    const context = makeContext();
    const header = encodePrincipal({
      identityProvider: 'aad',
      userId: 'u2',
      userDetails: 'operator@example.com',
      userRoles: ['authenticated', 'operator'],
    });
    const result = requireRole(makeRequest({ ...validSecretHeaders, 'x-ms-client-principal': header }), ['operator', 'admin'], context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.userId).toBe('u2');
    }
    expect(context.warnings).toHaveLength(0);
  });

  it('normalizes role comparison case-insensitively', () => {
    const context = makeContext();
    const header = encodePrincipal({
      identityProvider: 'aad',
      userId: 'u3',
      userDetails: 'admin@example.com',
      userRoles: ['Admin'],
    });
    const result = requireRole(makeRequest({ ...validSecretHeaders, 'x-ms-client-principal': header }), ['admin'], context);

    expect(result.ok).toBe(true);
  });
});

describe('requireMinimumRole — the mutation guard (viewer < operator < admin)', () => {
  it('rejects (403) a viewer on an operator-minimum route', () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'u', userRoles: ['viewer'] });
    const result = requireMinimumRole(makeRequest({ 'x-ms-client-principal': header }), 'operator', context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
    expect(context.warnings.some((w) => w.includes('insufficient role'))).toBe(true);
  });

  it('rejects (401) an unauthenticated caller on an operator-minimum route', () => {
    const context = makeContext();
    const result = requireMinimumRole(makeRequest(), 'operator', context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('allows an operator on an operator-minimum route', () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u2', userDetails: 'op@example.com', userRoles: ['operator'] });
    const result = requireMinimumRole(makeRequest({ 'x-ms-client-principal': header }), 'operator', context);

    expect(result.ok).toBe(true);
  });

  it('allows an admin on an operator-minimum route (admin is above operator in the hierarchy)', () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u3', userDetails: 'admin@example.com', userRoles: ['admin'] });
    const result = requireMinimumRole(makeRequest({ 'x-ms-client-principal': header }), 'operator', context);

    expect(result.ok).toBe(true);
  });

  it('rejects an operator on an admin-minimum route', () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u2', userDetails: 'op@example.com', userRoles: ['operator'] });
    const result = requireMinimumRole(makeRequest({ 'x-ms-client-principal': header }), 'admin', context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it('allows a viewer on a viewer-minimum route (the floor of the hierarchy)', () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'v@example.com', userRoles: ['viewer'] });
    const result = requireMinimumRole(makeRequest({ 'x-ms-client-principal': header }), 'viewer', context);

    expect(result.ok).toBe(true);
  });
});
