import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const queryAuditEntries = vi.fn();
const isAuditRequiredButMissing = vi.fn();
vi.mock('../lib/auditLog', async () => {
  const actual = await vi.importActual<typeof import('../lib/auditLog')>('../lib/auditLog');
  return {
    queryAuditEntries: (...args: unknown[]) => queryAuditEntries(...args),
    isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
    // Real implementation — pure and worth exercising for real (see the
    // AUDIT_READ log-forging test below), not worth stubbing.
    sanitizeForLog: actual.sanitizeForLog,
  };
});

const { auditRecent } = await import('./auditRecent');

interface FakeContext extends InvocationContext {
  logs: string[];
}

function makeContext(): FakeContext {
  const logs: string[] = [];
  return { warn: () => {}, error: () => {}, log: (...args: unknown[]) => logs.push(args.join(' ')), logs } as unknown as FakeContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'v1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}
function operatorHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'o1', userDetails: 'operator@example.com', userRoles: ['operator'] });
}
function adminHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'a1', userDetails: 'admin@example.com', userRoles: ['admin'] });
}

function makeRequest(options: { headers?: Record<string, string>; query?: Record<string, string> } = {}): HttpRequest {
  const { headers = {}, query = {} } = options;
  const lowerHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const queryMap = new Map(Object.entries(query));
  return {
    method: 'GET',
    url: 'https://func-example.azurewebsites.net/api/v1/audit/recent',
    headers: { get: (name: string) => lowerHeaders.get(name.toLowerCase()) ?? null },
    query: { get: (name: string) => queryMap.get(name) ?? null },
    params: {},
    json: async () => undefined,
  } as unknown as HttpRequest;
}

beforeEach(() => {
  queryAuditEntries.mockReset().mockResolvedValue({ entities: [], truncated: false, partial: false });
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auditRecent — role gate', () => {
  it('401s an unauthenticated caller', async () => {
    const response = await auditRecent(makeRequest(), makeContext());
    expect(response.status).toBe(401);
    expect(queryAuditEntries).not.toHaveBeenCalled();
  });

  it('403s a viewer — this endpoint is operator+ only (audit data includes actor identities)', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(403);
    expect(queryAuditEntries).not.toHaveBeenCalled();
  });

  it('200s for an operator', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(200);
  });

  it('200s for an admin', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), makeContext());
    expect(response.status).toBe(200);
  });
});

describe('auditRecent — param validation/bounds', () => {
  it('defaults top to 25 and sinceHours to 24 when omitted', async () => {
    await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(queryAuditEntries).toHaveBeenCalledWith({ top: 25, sinceHours: 24, actor: undefined, actionPrefix: undefined }, expect.anything());
  });

  it('passes through valid top/sinceHours/actor/actionPrefix', async () => {
    await auditRecent(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { top: '50', sinceHours: '168', actor: 'op@example.com', actionPrefix: 'sessionhost.' } }),
      makeContext(),
    );
    expect(queryAuditEntries).toHaveBeenCalledWith({ top: 50, sinceHours: 168, actor: 'op@example.com', actionPrefix: 'sessionhost.' }, expect.anything());
  });

  it('400s a non-integer top', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { top: 'abc' } }), makeContext());
    expect(response.status).toBe(400);
    expect(queryAuditEntries).not.toHaveBeenCalled();
  });

  it('400s a top above 100', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { top: '101' } }), makeContext());
    expect(response.status).toBe(400);
    expect((response.jsonBody as { code: string }).code).toBe('top_out_of_range');
  });

  it('400s a top below 1', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { top: '0' } }), makeContext());
    expect(response.status).toBe(400);
  });

  it('accepts top at exactly the 100 ceiling', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { top: '100' } }), makeContext());
    expect(response.status).toBe(200);
    expect(queryAuditEntries).toHaveBeenCalledWith(expect.objectContaining({ top: 100 }), expect.anything());
  });

  it('400s a sinceHours above 720', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { sinceHours: '721' } }), makeContext());
    expect(response.status).toBe(400);
    expect(queryAuditEntries).not.toHaveBeenCalled();
  });

  it('400s a sinceHours below 1', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { sinceHours: '0' } }), makeContext());
    expect(response.status).toBe(400);
  });

  it('AM-32 peer review MINOR 14 — sinceHours error text names ITS OWN param, not the generic "hours"', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { sinceHours: '0' } }), makeContext());
    expect((response.jsonBody as { message: string }).message).toContain('sinceHours');
  });

  it('accepts sinceHours at exactly the 720 ceiling', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { sinceHours: '720' } }), makeContext());
    expect(response.status).toBe(200);
    expect(queryAuditEntries).toHaveBeenCalledWith(expect.objectContaining({ sinceHours: 720 }), expect.anything());
  });

  it('treats a blank actor/actionPrefix as not supplied', async () => {
    await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { actor: '   ', actionPrefix: '' } }), makeContext());
    expect(queryAuditEntries).toHaveBeenCalledWith(expect.objectContaining({ actor: undefined, actionPrefix: undefined }), expect.anything());
  });

  it('400s an oversized actor', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { actor: 'a'.repeat(321) } }), makeContext());
    expect(response.status).toBe(400);
    expect((response.jsonBody as { code: string }).code).toBe('actor_too_long');
  });

  it('400s an oversized actionPrefix', async () => {
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { actionPrefix: 'a'.repeat(201) } }), makeContext());
    expect(response.status).toBe(400);
    expect((response.jsonBody as { code: string }).code).toBe('actionPrefix_too_long');
  });
});

describe('auditRecent — mapping', () => {
  it('maps AuditEntity rows to AuditEntryDto, omitting parametersJson/detail and deriving hasParameters', async () => {
    queryAuditEntries.mockResolvedValue({
      entities: [
        {
          partitionKey: '2026-08-15',
          rowKey: 'x',
          actor: 'op@example.com',
          actorId: 'id-1',
          action: 'sessionhost.drain',
          target: 'HP-CONTOSO-PROD/avd-con-0',
          parametersJson: JSON.stringify({ allowNewSession: false }),
          reason: 'scheduled maintenance',
          outcome: 'success',
          detail: 'internal detail that must not leak',
          correlationId: 'corr-1',
          occurredAt: '2026-08-15T12:00:00.000Z',
        },
      ],
      truncated: false,
      partial: false,
    });

    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(200);
    const body = response.jsonBody as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toEqual({
      id: '2026-08-15/x',
      occurredAt: '2026-08-15T12:00:00.000Z',
      actor: 'op@example.com',
      action: 'sessionhost.drain',
      target: 'HP-CONTOSO-PROD/avd-con-0',
      reason: 'scheduled maintenance',
      outcome: 'success',
      correlationId: 'corr-1',
      hasParameters: true,
    });
    expect(body.entries[0]).not.toHaveProperty('parametersJson');
    expect(body.entries[0]).not.toHaveProperty('detail');
  });

  it('AM-32 peer review MAJOR 1 — `id` is {partitionKey}/{rowKey}, distinct even when TWO rows share the same correlationId (the rolloutPlanTimer.ts one-id-per-tick, one-row-per-plan case)', async () => {
    queryAuditEntries.mockResolvedValue({
      entities: [
        { partitionKey: '2026-08-15', rowKey: 'row-a', actor: 'system', actorId: 'sys', action: 'rollout.timer_advance', target: 'HP-CONTOSO-PROD/plan-1', outcome: 'success', correlationId: 'shared-corr', occurredAt: '2026-08-15T12:00:00.000Z' },
        { partitionKey: '2026-08-15', rowKey: 'row-b', actor: 'system', actorId: 'sys', action: 'rollout.timer_advance', target: 'HP-CONTOSO-PROD/plan-2', outcome: 'success', correlationId: 'shared-corr', occurredAt: '2026-08-15T12:00:00.000Z' },
      ],
      truncated: false,
      partial: false,
    });
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    const body = response.jsonBody as { entries: Array<{ id: string; correlationId: string }> };
    expect(body.entries[0].correlationId).toBe(body.entries[1].correlationId);
    expect(body.entries[0].id).not.toBe(body.entries[1].id);
    expect(new Set(body.entries.map((e) => e.id)).size).toBe(2);
  });

  it('reports hasParameters:false when the row had no parametersJson', async () => {
    queryAuditEntries.mockResolvedValue({
      entities: [
        { partitionKey: '2026-08-15', rowKey: 'x', actor: 'a', actorId: 'id', action: 'sessionhost.resume', target: 't', outcome: 'success', correlationId: 'c1', occurredAt: '2026-08-15T12:00:00.000Z' },
      ],
      truncated: false,
      partial: false,
    });
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    const body = response.jsonBody as { entries: Array<{ hasParameters: boolean }> };
    expect(body.entries[0].hasParameters).toBe(false);
  });

  it('passes through an "accepted" outcome unchanged', async () => {
    queryAuditEntries.mockResolvedValue({
      entities: [
        { partitionKey: '2026-08-15', rowKey: 'x', actor: 'a', actorId: 'id', action: 'sessionhost.restart', target: 't', outcome: 'accepted', correlationId: 'c1', occurredAt: '2026-08-15T12:00:00.000Z' },
      ],
      truncated: false,
      partial: false,
    });
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    const body = response.jsonBody as { entries: Array<{ outcome: string }> };
    expect(body.entries[0].outcome).toBe('accepted');
  });

  it('echoes truncated, partial, and the effective sinceHours in the response body', async () => {
    queryAuditEntries.mockResolvedValue({ entities: [], truncated: true, partial: false });
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { sinceHours: '168' } }), makeContext());
    const body = response.jsonBody as { truncated: boolean; partial: boolean; sinceHours: number };
    expect(body.truncated).toBe(true);
    expect(body.partial).toBe(false);
    expect(body.sinceHours).toBe(168);
  });

  it('AM-32 peer review MAJOR 3 — echoes partial:true straight through when queryAuditEntries reports a mid-walk failure', async () => {
    queryAuditEntries.mockResolvedValue({ entities: [], truncated: true, partial: true });
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    const body = response.jsonBody as { truncated: boolean; partial: boolean };
    expect(body.truncated).toBe(true);
    expect(body.partial).toBe(true);
  });

  it('returns an empty entries array (not an error) when there is nothing to show', async () => {
    queryAuditEntries.mockResolvedValue({ entities: [], truncated: false, partial: false });
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(200);
    const body = response.jsonBody as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });
});

describe('auditRecent — audit store not configured (AM-32 peer review MAJOR 2)', () => {
  it('503s with audit_not_configured, and never calls queryAuditEntries, when isAuditRequiredButMissing() is true', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(503);
    expect((response.jsonBody as { code: string }).code).toBe('audit_not_configured');
    expect(queryAuditEntries).not.toHaveBeenCalled();
  });

  it('still validates params BEFORE checking audit-store configuration — a malformed request 400s, not 503s', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { top: 'abc' } }), makeContext());
    expect(response.status).toBe(400);
  });

  it('does not affect a properly-configured store (isAuditRequiredButMissing false -> normal 200)', async () => {
    isAuditRequiredButMissing.mockReturnValue(false);
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(200);
  });
});

describe('auditRecent — structured AUDIT_READ log line (peer review MINOR 18/19)', () => {
  it('logs the requesting actor and applied filters on every successful call', async () => {
    const context = makeContext();
    await auditRecent(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { top: '10', sinceHours: '168', actor: 'jdoe@example.com', actionPrefix: 'sessionhost.' } }),
      context,
    );
    const line = context.logs.find((l) => l.startsWith('AUDIT_READ'));
    expect(line).toBeDefined();
    expect(line).toContain('requestedBy=operator@example.com');
    expect(line).toContain('top=10');
    expect(line).toContain('sinceHours=168');
    expect(line).toContain('actor=jdoe@example.com');
    expect(line).toContain('actionPrefix=sessionhost.');
  });

  it('strips CR/LF from actor/actionPrefix before they reach the AUDIT_READ log line (log-forging hygiene)', async () => {
    const context = makeContext();
    await auditRecent(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, query: { actor: 'evil\r\nAUDIT_READ | forged=true', actionPrefix: 'x\ninjected' } }),
      context,
    );
    const auditReadLines = context.logs.filter((l) => l.includes('AUDIT_READ'));
    expect(auditReadLines).toHaveLength(1);
    expect(auditReadLines[0]).not.toContain('\n');
    expect(auditReadLines[0]).not.toContain('\r');
  });

  it('does not log AUDIT_READ for a request that never reaches the query (403/400)', async () => {
    const context = makeContext();
    await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);
    expect(context.logs.some((l) => l.startsWith('AUDIT_READ'))).toBe(false);
  });
});

describe('auditRecent — failure handling', () => {
  it('502s with a correlation id when queryAuditEntries throws unexpectedly', async () => {
    queryAuditEntries.mockRejectedValue(new Error('unexpected'));
    const response = await auditRecent(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(502);
    expect((response.jsonBody as { code: string }).code).toBe('audit_recent_failed');
  });
});
