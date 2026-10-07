import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const sendSessionMessage = vi.fn();
const isNotFoundError = vi.fn().mockReturnValue(false);
vi.mock('../services/avdService', () => ({
  sendSessionMessage: (...args: unknown[]) => sendSessionMessage(...args),
  isNotFoundError: (...args: unknown[]) => isNotFoundError(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { sessionSendMessage: handler } = await import('./sessionSendMessage');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: {
  headers?: Record<string, string>;
  hostPoolName?: string;
  sessionHostName?: string;
  sessionId?: string;
  body?: unknown;
  jsonThrows?: boolean;
}): HttpRequest {
  const {
    headers = {},
    hostPoolName = 'HP-CONTOSO-PROD',
    sessionHostName = 'avd-con-0',
    sessionId = '1',
    body = { title: 'Notice', body: 'Please save your work.' },
    jsonThrows = false,
  } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/avd-con-0/sessions/1/message',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { hostPoolName, sessionHostName, sessionId },
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

function makeContext(): FakeContext {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const logs: unknown[] = [];
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

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  sendSessionMessage.mockReset().mockResolvedValue(undefined);
  isNotFoundError.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sessionSendMessage — role rejection path', () => {
  it('returns 403 for a viewer', async () => {
    const context = makeContext();
    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await handler(makeRequest({}), context);

    expect(response.status).toBe(401);
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });
});

describe('sessionSendMessage — mandatory body / optional title', () => {
  it('returns 400 when body is missing', async () => {
    const context = makeContext();
    const response = await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { title: 'Notice' } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_body' });
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('returns 400 when body is whitespace-only', async () => {
    const context = makeContext();
    const response = await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { body: '   ' } }),
      context,
    );

    expect(response.status).toBe(400);
  });

  it('returns 400 when body exceeds 1000 characters', async () => {
    const context = makeContext();
    const response = await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { body: 'x'.repeat(1001) } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'body_too_long' });
  });

  it('accepts a request with no title at all (title is optional)', async () => {
    const context = makeContext();
    const response = await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { body: 'Please save your work.' } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(sendSessionMessage).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', '1', undefined, 'Please save your work.');
  });

  it('returns 400 when title exceeds 200 characters', async () => {
    const context = makeContext();
    const response = await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { title: 'x'.repeat(201), body: 'hi' } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'title_too_long' });
  });
});

describe('sessionSendMessage — fail-closed audit posture', () => {
  it('returns 500 and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });
});

describe('sessionSendMessage — happy path', () => {
  it('calls the service and writes a success audit row with a truncated body preview, not the full body', async () => {
    const longBody = 'x'.repeat(150);
    const context = makeContext();

    const response = await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-obj-op-1') }, body: { title: 'Heads up', body: longBody } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ sessionId: '1' });
    expect(sendSessionMessage).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', '1', 'Heads up', longBody);

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ actor: 'op@example.com', actorId: 'entra-obj-op-1', action: 'session.sendMessage', target: 'HP-CONTOSO-PROD/avd-con-0/1', outcome: 'success' });
    expect(event.parameters.bodyLength).toBe(150);
    expect(event.parameters.bodyPreview).not.toBe(longBody);
    expect(event.parameters.bodyPreview.length).toBeLessThan(longBody.length);
  });

  it('stores the full body as the preview when it is under the preview threshold', async () => {
    const context = makeContext();

    await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { body: 'short message' } }), context);

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters.bodyPreview).toBe('short message');
  });

  it('trims a padded title and body before sending to ARM and before auditing', async () => {
    const context = makeContext();

    await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { title: '  Heads up  ', body: '  Please save your work.  ' } }),
      context,
    );

    expect(sendSessionMessage).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', '1', 'Heads up', 'Please save your work.');
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters.title).toBe('Heads up');
    expect(event.parameters.bodyPreview).toBe('Please save your work.');
  });

  it('normalizes a whitespace-only title to undefined (not sent, not audited as a blank string)', async () => {
    const context = makeContext();

    await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { title: '   ', body: 'hello' } }), context);

    expect(sendSessionMessage).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', '1', undefined, 'hello');
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters.title).toBeUndefined();
  });
});

describe('sessionSendMessage — failure paths', () => {
  it('writes a failure audit row and returns 502 when the service call fails', async () => {
    sendSessionMessage.mockRejectedValue(new Error('ARM timeout'));
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'session_send_message_failed' });
    expect(writeAuditEntry.mock.calls[0][0]).toMatchObject({ outcome: 'failure' });
  });

  it('logs only the error MESSAGE via context.error, never the raw error object (CWE-532)', async () => {
    const armError = Object.assign(new Error('secret ARM detail'), { request: { body: 'sensitive-payload' } });
    sendSessionMessage.mockRejectedValue(armError);
    const context = makeContext();

    await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    for (const call of context.errors as unknown[][]) {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe('string');
    }
    expect(context.errors.some((e) => String(e).includes('secret ARM detail'))).toBe(true);
  });

  it('maps a not-found ARM error to 404', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    sendSessionMessage.mockRejectedValue(notFound);
    isNotFoundError.mockReturnValue(true);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'session_not_found' });
  });
});
