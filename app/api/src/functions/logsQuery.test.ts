import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const runLogsQuery = vi.fn();
vi.mock('../services/logsService', () => ({
  runLogsQuery: (...args: unknown[]) => runLogsQuery(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { logsQuery } = await import('./logsQuery');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: string[];
}

function makeRequest(options: { headers?: Record<string, string>; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { headers = {}, body = { kql: 'WVDConnections | take 10', timespanHours: 24 }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: 'POST',
    url: 'https://func-example.azurewebsites.net/api/v1/logs/query',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: {},
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

function makeContext(): FakeContext {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const logs: string[] = [];
  return {
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    error: (...args: unknown[]) => errors.push(args),
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    warnings,
    errors,
    logs,
  } as unknown as FakeContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function operatorHeader(userDetails = 'operator@example.com', userId = 'entra-obj-id-op') {
  return encodePrincipal({ identityProvider: 'aad', userId, userDetails, userRoles: ['operator'] });
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

const SAMPLE_RESULT = { tables: [{ columns: [{ name: 'Col1', type: 'string' }], rows: [['value']], truncated: false }] };

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.REQUIRE_BACKEND_SECRET;
  runLogsQuery.mockReset().mockResolvedValue(SAMPLE_RESULT);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('logsQuery — role gating (operator+ ONLY, not viewer)', () => {
  it('returns 403 for a viewer and never calls runLogsQuery or writes an audit row', async () => {
    const context = makeContext();
    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(runLogsQuery).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await logsQuery(makeRequest({}), context);

    expect(response.status).toBe(401);
    expect(runLogsQuery).not.toHaveBeenCalled();
  });

  it('allows an operator', async () => {
    const context = makeContext();
    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
  });
});

describe('logsQuery — validation', () => {
  it('returns 400 for a malformed JSON body', async () => {
    const context = makeContext();
    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, jsonThrows: true }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_body' });
    expect(runLogsQuery).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing kql', async () => {
    const context = makeContext();
    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { timespanHours: 24 } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_kql' });
    expect(runLogsQuery).not.toHaveBeenCalled();
  });

  it('returns 400 for kql over MAX_KQL_LENGTH', async () => {
    const context = makeContext();
    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { kql: 'a'.repeat(8001), timespanHours: 24 } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'kql_too_long' });
    expect(runLogsQuery).not.toHaveBeenCalled();
  });

  it('returns 400 for an out-of-range timespanHours, and validates BEFORE calling runLogsQuery', async () => {
    const context = makeContext();
    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { kql: 'WVDConnections | take 1', timespanHours: 999 } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'timespan_out_of_range' });
    expect(runLogsQuery).not.toHaveBeenCalled();
  });
});

describe('logsQuery — fail-closed audit posture (peer review MAJOR 2)', () => {
  it('returns 500 and never calls runLogsQuery when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(runLogsQuery).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect(context.errors.some((e) => String(e).includes('AUDIT_MISCONFIGURED'))).toBe(true);
  });

  it('still returns 400 for invalid input even when audit is unavailable (validation happens first)', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { timespanHours: 24 } }), context);

    expect(response.status).toBe(400);
  });
});

describe('logsQuery — audit content (peer review MAJOR 2: every run is audited)', () => {
  it('writes a success audit row with a SHA-256-hash target (not the raw kql), structured parameters, and the (truncated) kql text in detail', async () => {
    const context = makeContext();
    const kql = 'WVDConnections | take 10';
    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-obj-op-1') }, body: { kql, timespanHours: 48 } }), context);

    expect(response.status).toBe(200);
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];

    expect(event.action).toBe('logs.query');
    expect(event.actor).toBe('op@example.com');
    expect(event.actorId).toBe('entra-obj-op-1');
    expect(event.outcome).toBe('success');
    expect(event.parameters).toEqual({ timespanHours: 48, kqlLength: kql.length });
    expect(event.detail).toBe(kql);

    // target must be a hash, not the raw kql text — it must never leak the
    // query itself into a field that's presumably shorter/more visible.
    const expectedHash = createHash('sha256').update(kql).digest('hex').slice(0, 16);
    expect(event.target).toBe(`kql-sha256:${expectedHash}`);
    expect(event.target).not.toContain(kql);
  });

  it('truncates a very long kql to 1000 chars in the audit detail field', async () => {
    const context = makeContext();
    const kql = `WVDConnections | where UserName == "${'a'.repeat(7900)}"`;
    await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { kql, timespanHours: 24 } }), context);

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.detail.length).toBeLessThan(kql.length);
    expect(event.detail.length).toBeLessThanOrEqual(1000 + '…(truncated)'.length);
  });

  it('writes a failure audit row (still hash-based target) when runLogsQuery rejects, and returns 502', async () => {
    runLogsQuery.mockRejectedValue(new Error('workspace unreachable'));
    const context = makeContext();
    const kql = 'WVDConnections | take 10';

    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { kql, timespanHours: 24 } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'logs_query_failed' });
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('failure');
    expect(event.detail).toBe(kql);
  });

  it('still returns 200 when writeAuditEntry rejects (the query already succeeded)', async () => {
    writeAuditEntry.mockRejectedValueOnce(new Error('table unreachable'));
    const context = makeContext();

    const response = await logsQuery(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(context.warnings.some((w) => w.includes('audit write threw unexpectedly'))).toBe(true);
  });
});
