import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getTokenMock = vi.fn();

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(function DefaultAzureCredential() {
    return { getToken: getTokenMock };
  }),
}));

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(() => {
  getTokenMock.mockReset();
  getTokenMock.mockResolvedValue({ token: 'fake-token' });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('restGet', () => {
  it('returns undefined on 404 without throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404, { error: { code: 'NotFound' } }));
    const { restGet } = await import('./restClient');
    await expect(restGet('https://example.test/x', 'scope')).resolves.toBeUndefined();
  });

  it('throws RestClientError with statusCode/code on a non-2xx, non-404 response', async () => {
    // A fresh Response per call — Response.json() consumes the body stream,
    // so reusing one mocked object across two restGet() calls would make
    // the second call's parseErrorBody see an already-consumed stream.
    vi.mocked(fetch).mockImplementation(async () => jsonResponse(403, { error: { code: 'AuthorizationFailed', message: 'denied' } }));
    const { restGet, RestClientError } = await import('./restClient');
    await expect(restGet('https://example.test/x', 'scope')).rejects.toBeInstanceOf(RestClientError);
    await expect(restGet('https://example.test/x', 'scope')).rejects.toMatchObject({ statusCode: 403, code: 'AuthorizationFailed' });
  });

  it('handles a malformed (non-JSON) error body without throwing a secondary parse error', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not json', { status: 500 }));
    const { restGet, RestClientError } = await import('./restClient');
    await expect(restGet('https://example.test/x', 'scope')).rejects.toBeInstanceOf(RestClientError);
  });

  it('re-acquires a token for the request (calls getToken)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true }));
    const { restGet } = await import('./restClient');
    await restGet('https://example.test/x', 'my-scope');
    expect(getTokenMock).toHaveBeenCalledWith('my-scope');
  });

  it('sends an explicit GET method', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true }));
    const { restGet } = await import('./restClient');
    await restGet('https://example.test/x', 'scope');
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
  });
});

describe('restList', () => {
  it('follows nextLink across multiple pages and concatenates value arrays', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { value: [{ id: 1 }], nextLink: 'https://example.test/page2' }))
      .mockResolvedValueOnce(jsonResponse(200, { value: [{ id: 2 }] }));
    const { restList } = await import('./restClient');
    const result = await restList<{ id: number }>('https://example.test/page1', 'scope', 'nextLink');
    expect(result).toEqual({ items: [{ id: 1 }, { id: 2 }], truncated: false });
  });

  it('re-acquires a token on every page', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { value: [{ id: 1 }], nextLink: 'https://example.test/page2' }))
      .mockResolvedValueOnce(jsonResponse(200, { value: [{ id: 2 }] }));
    const { restList } = await import('./restClient');
    await restList('https://example.test/page1', 'scope', 'nextLink');
    expect(getTokenMock).toHaveBeenCalledTimes(2);
  });

  it('reports truncated:true and stops when the page ceiling is hit, never silently dropping the cutoff', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const n = Number(new URL(String(url)).searchParams.get('p') ?? '0');
      return jsonResponse(200, { value: [{ id: n }], nextLink: `https://example.test/page?p=${n + 1}` });
    });
    const { restList } = await import('./restClient');
    const result = await restList<{ id: number }>('https://example.test/page?p=0', 'scope', 'nextLink');
    expect(result.truncated).toBe(true);
    expect(result.items.length).toBe(20);
  });

  it('throws by default on a 404 for the list URL (no silent false pass)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404, { error: { code: 'NotFound' } }));
    const { restList, RestClientError } = await import('./restClient');
    await expect(restList('https://example.test/x', 'scope', 'nextLink')).rejects.toBeInstanceOf(RestClientError);
  });

  it('treats a 404 as empty ONLY when treat404AsEmpty is explicitly set', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404, { error: { code: 'NotFound' } }));
    const { restList } = await import('./restClient');
    const result = await restList('https://example.test/x', 'scope', 'nextLink', { treat404AsEmpty: true });
    expect(result).toEqual({ items: [], truncated: false });
  });

  it('throws RestClientError on a 403', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, { error: { code: 'AuthorizationFailed' } }));
    const { restList, RestClientError } = await import('./restClient');
    await expect(restList('https://example.test/x', 'scope', 'nextLink')).rejects.toBeInstanceOf(RestClientError);
  });
});

describe('retry on 429/503', () => {
  it('retries once, honoring a numeric (seconds) Retry-After header, and succeeds on the retry', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '1' })).mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      const { restGet } = await import('./restClient');
      const promise = restGet('https://example.test/x', 'scope');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the retry delay rather than honoring an unbounded Retry-After', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(503, {}, { 'Retry-After': '3600' })).mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      const { restGet } = await import('./restClient');
      const promise = restGet('https://example.test/x', 'scope');
      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a second time — a repeat 429 propagates as an error', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(429, {}, { 'Retry-After': '0' }));
      const { restGet, RestClientError } = await import('./restClient');
      const promise = restGet('https://example.test/x', 'scope').catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;
      expect(result).toBeInstanceOf(RestClientError);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('timeout', () => {
  it('passes an AbortSignal to fetch so a hung request is bounded', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true }));
    const { restGet } = await import('./restClient');
    await restGet('https://example.test/x', 'scope');
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('restPut', () => {
  it('sends a PUT with a JSON body and returns the parsed response', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, { id: 'created' }));
    const { restPut } = await import('./restClient');
    const result = await restPut('https://example.test/x', 'scope', { properties: { a: 1 } });
    expect(result).toEqual({ id: 'created' });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/x');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ properties: { a: 1 } }));
  });

  it('throws RestClientError on a non-2xx response', async () => {
    // A fresh Response per call — see restGet's identical test comment above.
    vi.mocked(fetch).mockImplementation(async () => jsonResponse(403, { error: { code: 'AuthorizationFailed', message: 'denied' } }));
    const { restPut, RestClientError } = await import('./restClient');
    await expect(restPut('https://example.test/x', 'scope', {})).rejects.toBeInstanceOf(RestClientError);
    await expect(restPut('https://example.test/x', 'scope', {})).rejects.toMatchObject({ statusCode: 403, code: 'AuthorizationFailed' });
  });

  it('does not retry on 429 — a write must not silently double-apply', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(429, {}, { 'Retry-After': '0' }));
    const { restPut, RestClientError } = await import('./restClient');
    await expect(restPut('https://example.test/x', 'scope', {})).rejects.toBeInstanceOf(RestClientError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('restDelete', () => {
  it('sends a DELETE and resolves on 2xx', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const { restDelete } = await import('./restClient');
    await expect(restDelete('https://example.test/x', 'scope')).resolves.toBeUndefined();
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
  });

  it('treats a 404 as success — idempotent delete', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404, { error: { code: 'NotFound' } }));
    const { restDelete } = await import('./restClient');
    await expect(restDelete('https://example.test/x', 'scope')).resolves.toBeUndefined();
  });

  it('throws RestClientError on a non-2xx, non-404 response (e.g. an ABAC condition rejection)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, { error: { code: 'AuthorizationFailed' } }));
    const { restDelete, RestClientError } = await import('./restClient');
    await expect(restDelete('https://example.test/x', 'scope')).rejects.toBeInstanceOf(RestClientError);
  });
});
