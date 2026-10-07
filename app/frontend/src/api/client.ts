import type { ApiError } from '@avdmgr/shared';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Thrown by apiFetch when the API responds with a non-2xx status. */
export class ApiClientError extends Error implements ApiError {
  status: number;
  code: string;
  details?: unknown;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiClientError';
    this.status = error.status;
    this.code = error.code;
    this.details = error.details;
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Aborts the request after this many ms. Defaults to 30s. */
  timeoutMs?: number;
}

function sessionExpiredError(): ApiClientError {
  return new ApiClientError({
    status: 401,
    code: 'session_expired',
    message: 'Your session has expired. Redirecting to sign in…',
  });
}

/** Combines an optional caller-supplied AbortSignal with a timeout signal. */
function createRequestSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

/**
 * Typed fetch wrapper for calling the AVD Manager API.
 *
 * - Same-origin by design (frontend + linked API are served from the same SWA
 *   origin), so no `credentials: 'include'` is needed — the default
 *   'same-origin' mode already sends the SWA auth cookie.
 * - Serializes/deserializes JSON automatically.
 * - Treats a redirected response, or a 2xx response that isn't JSON, as an
 *   expired session (SWA redirects unauthenticated /api/* calls to a login
 *   page, which itself returns 200 text/html) — sends the browser to sign in
 *   and throws, rather than silently returning `undefined` to the caller.
 * - Aborts after `timeoutMs` (default 30s), combined with any caller-supplied
 *   AbortSignal.
 * - Normalizes failures into ApiClientError so callers can catch one type.
 */
export async function apiFetch<TResponse = unknown>(path: string, options: ApiFetchOptions = {}): Promise<TResponse> {
  const { body, headers, signal, timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = options;

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    signal: createRequestSignal(signal, timeoutMs),
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.redirected) {
    if (typeof window !== 'undefined') {
      window.location.assign('/.auth/login/aad');
    }
    throw sessionExpiredError();
  }

  // 204 No Content (AM-24: ack/snooze/unack/unsnooze — see
  // app/api/src/functions/alertAck.ts) has no body and, correctly, no
  // Content-Type header at all — MUST be special-cased before the
  // response.ok && !isJson check below, which otherwise exists to catch a
  // completely different case (SWA redirecting an expired session to an
  // HTML login page with a 200) and would misfire on every legitimate 204.
  if (response.status === 204) {
    return undefined as TResponse;
  }

  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;

  if (response.ok && !isJson) {
    if (typeof window !== 'undefined') {
      window.location.assign('/.auth/login/aad');
    }
    throw sessionExpiredError();
  }

  const payload = isJson ? await response.json().catch(() => undefined) : undefined;

  if (!response.ok) {
    if (payload && typeof payload === 'object' && 'message' in payload) {
      throw new ApiClientError(payload as ApiError);
    }
    throw new ApiClientError({
      status: response.status,
      code: 'unknown_error',
      message: response.statusText || `Request failed with status ${response.status}`,
    });
  }

  return payload as TResponse;
}

export const apiClient = {
  get: <T>(path: string, options?: ApiFetchOptions) => apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: ApiFetchOptions) => apiFetch<T>(path, { ...options, method: 'DELETE' }),
};
