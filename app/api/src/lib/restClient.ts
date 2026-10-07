import { DefaultAzureCredential } from '@azure/identity';

/*
 * AM-16 (M3b) — Opus peer review fixes. Shared authenticated-REST core for
 * armRest.ts and graphRest.ts (peer review item 19: "dedupe shared
 * restClient core for armRest/graphRest, parameterized base URL/scope/404
 * policy") — the two files were near-identical hand-rolled fetch wrappers;
 * this is the one place that now owns: token acquisition (re-acquired on
 * EVERY request, including every page of a paginated list — item 19 — since
 * @azure/identity's DefaultAzureCredential already caches internally per
 * its documented behavior, so re-acquiring is cheap and removes any risk of
 * a long-lived pagination loop using a token that expired mid-loop),
 * request timeout, and 429/503 retry-once-honoring-Retry-After (peer review
 * item 8).
 */

const FETCH_TIMEOUT_MS = 15_000;
/** Safety ceiling on how long this module will sleep for a single 429/503 retry, even if the server's own Retry-After asks for longer — bounds the worst case added latency per call rather than trusting an arbitrarily large server-supplied value. */
const MAX_RETRY_DELAY_MS = 5_000;

export class RestClientError extends Error {
  statusCode: number;
  code: string | undefined;

  constructor(statusCode: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'RestClientError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isRestNotFound(error: unknown): boolean {
  return error instanceof RestClientError && error.statusCode === 404;
}

export function isRestForbidden(error: unknown): boolean {
  return error instanceof RestClientError && error.statusCode === 403;
}

/** AM-14 peer review (fix 8): distinguishes a 409 Conflict (e.g. ARM's RoleAssignmentExists — a role assignment already exists for this principal/role/scope combination) so a call site can map it to a specific, actionable error instead of a generic failure. */
export function isRestConflict(error: unknown): boolean {
  return error instanceof RestClientError && error.statusCode === 409;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

let cachedCredential: DefaultAzureCredential | undefined;

function getCredential(): DefaultAzureCredential {
  if (!cachedCredential) {
    cachedCredential = new DefaultAzureCredential();
  }
  return cachedCredential;
}

async function getAccessToken(tokenScope: string): Promise<string> {
  const token = await getCredential().getToken(tokenScope);
  if (!token) {
    throw new Error(`Failed to acquire an access token for scope "${tokenScope}" (DefaultAzureCredential returned null).`);
  }
  return token.token;
}

async function parseErrorBody(response: Response): Promise<ErrorEnvelope | undefined> {
  try {
    return (await response.json()) as ErrorEnvelope;
  } catch {
    return undefined;
  }
}

/**
 * Parses a `Retry-After` header value per its two documented forms — an
 * integer number of seconds, or an HTTP-date (RFC 7231 §7.1.3, the same
 * header both ARM throttling responses and Microsoft Graph throttling
 * responses document — verified against Microsoft Learn's ARM throttling
 * guidance and the Graph throttling guidance, both of which point at this
 * standard header rather than a service-specific one). Returns 0 (retry
 * immediately) if the header is missing or unparseable — a missing
 * Retry-After on a 429/503 is itself unusual, but should not be treated as
 * "wait forever."
 */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce(url: string, tokenScope: string): Promise<Response> {
  const token = await getAccessToken(tokenScope);
  return fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/**
 * GETs `url` with a bearer token for `tokenScope`, a 15s per-request timeout
 * (AbortSignal.timeout — a genuinely hung/slow ARM or Graph call must not
 * hold a governance check open indefinitely), and a SINGLE retry on 429
 * (Too Many Requests) or 503 (Service Unavailable), honoring Retry-After
 * (capped at MAX_RETRY_DELAY_MS). A second 429/503 on the retry is NOT
 * retried again — this is a governance/read-only check, not a
 * critical-path mutation, so one retry is a reasonable throttling
 * accommodation without risking a check hanging through a sustained outage.
 */
export async function restFetch(url: string, tokenScope: string): Promise<Response> {
  const response = await fetchOnce(url, tokenScope);
  if (response.status !== 429 && response.status !== 503) {
    return response;
  }
  const delayMs = Math.min(parseRetryAfterMs(response.headers.get('Retry-After')), MAX_RETRY_DELAY_MS);
  await sleep(delayMs);
  return fetchOnce(url, tokenScope);
}

/**
 * GETs a single resource. Returns `undefined` (never throws) on a 404 — the
 * common, often meaningful "not found" outcome for a governance check (e.g.
 * no budget configured) — every OTHER non-2xx status throws
 * RestClientError.
 */
export async function restGet<T>(url: string, tokenScope: string): Promise<T | undefined> {
  const response = await restFetch(url, tokenScope);

  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new RestClientError(response.status, body?.error?.code, body?.error?.message ?? `GET ${url} failed with HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

/**
 * PUTs `body` (JSON) to `url` with a bearer token for `tokenScope` — AM-14's
 * write counterpart to restGet, added for armRest.ts#armPut (creating a
 * specific-named ARM resource, e.g. a role assignment PUT at a caller-
 * generated GUID name — see accessService.ts#createDesktopAssignment). No
 * 429/503 retry (unlike restFetch/restGet, used only for reads): a 429/503
 * on a WRITE gives no guarantee the first attempt didn't already partially
 * apply server-side, so blindly retrying on the caller's behalf here would
 * risk a double-apply the caller never asked for — the caller decides
 * whether/how to retry a failed write. Throws RestClientError on any
 * non-2xx response; never returns undefined (a PUT that "succeeds" always
 * has a body per ARM's documented Role Assignments - Create contract).
 */
export async function restPut<T>(url: string, tokenScope: string, body: unknown): Promise<T> {
  const token = await getAccessToken(tokenScope);
  const response = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errBody = await parseErrorBody(response);
    throw new RestClientError(response.status, errBody?.error?.code, errBody?.error?.message ?? `PUT ${url} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * DELETEs `url` with a bearer token for `tokenScope` — AM-14's other write
 * primitive, added for armRest.ts#armDelete (removing a role assignment —
 * see accessService.ts#removeDesktopAssignment). A 404 is treated as
 * SUCCESS, not an error — ARM's delete is documented idempotent (deleting an
 * already-gone role assignment is a no-op, not a failure), matching this
 * app's existing "delete of something already gone is not an error" posture
 * elsewhere (e.g. avdService.ts#removeSessionHost's callers). Any OTHER
 * non-2xx (including a 403 from the ABAC condition blocking a
 * non-Desktop-Virtualization-User delete — see the bicep module's
 * condition) throws RestClientError, same as every other write here.
 */
export async function restDelete(url: string, tokenScope: string): Promise<void> {
  const token = await getAccessToken(tokenScope);
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 404) {
    return;
  }
  if (!response.ok) {
    const errBody = await parseErrorBody(response);
    throw new RestClientError(response.status, errBody?.error?.code, errBody?.error?.message ?? `DELETE ${url} failed with HTTP ${response.status}`);
  }
}

export interface RestListResult<T> {
  items: T[];
  /** True when the page-count ceiling (MAX_LIST_PAGES) was hit before pagination finished — `items` is a PARTIAL result in that case, never silently presented as complete. Every call site MUST surface this in its evidence (peer review item 6) rather than swallow it. */
  truncated: boolean;
}

export interface RestListOptions {
  /**
   * When true, a 404 for the LIST url itself is treated as "empty"
   * ({ items: [], truncated: false }) instead of throwing. Use ONLY for
   * endpoints where "the parent/target resource doesn't support this
   * extension collection" is itself a normal, meaningful "no data" state
   * (diagnosticSettings, locks — both scoped to a SPECIFIC already-known-to-
   * exist resource). Do NOT set this for resource-group/subscription-level
   * enumeration (private endpoints, snapshots, disks, generic resources,
   * etc.) — there, a 404 usually means the target resource group/VNet/etc.
   * was renamed or deleted out from under this app's configuration, which
   * MUST surface as a real, loud error (peer review item 5: "a renamed VNet
   * must not yield a silent false pass") rather than a silent empty result
   * that a scanner would read as "nothing to report."
   */
  treat404AsEmpty?: boolean;
}

const MAX_LIST_PAGES = 20;

/**
 * LISTs a collection at `url` (a `{ value: [...] }` envelope with a
 * next-page link under `nextLinkField` — `'nextLink'` for ARM,
 * `'@odata.nextLink'` for Graph), following pagination up to
 * MAX_LIST_PAGES pages. See RestListOptions.treat404AsEmpty for the 404
 * policy (opt-in, off by default — peer review item 5).
 */
export async function restList<T>(url: string, tokenScope: string, nextLinkField: string, options: RestListOptions = {}): Promise<RestListResult<T>> {
  let nextUrl: string | undefined = url;
  const items: T[] = [];
  let pages = 0;
  let truncated = false;

  while (nextUrl) {
    if (pages >= MAX_LIST_PAGES) {
      truncated = true;
      break;
    }

    const response: Response = await restFetch(nextUrl, tokenScope);

    if (response.status === 404) {
      if (options.treat404AsEmpty) {
        return { items, truncated: false };
      }
      const body = await parseErrorBody(response);
      throw new RestClientError(404, body?.error?.code, body?.error?.message ?? `LIST ${nextUrl} failed with HTTP 404`);
    }
    if (!response.ok) {
      const body = await parseErrorBody(response);
      throw new RestClientError(response.status, body?.error?.code, body?.error?.message ?? `LIST ${nextUrl} failed with HTTP ${response.status}`);
    }

    const page = (await response.json()) as Record<string, unknown> & { value?: T[] };
    items.push(...(page.value ?? []));
    nextUrl = typeof page[nextLinkField] === 'string' ? (page[nextLinkField] as string) : undefined;
    pages += 1;
  }

  return { items, truncated };
}
