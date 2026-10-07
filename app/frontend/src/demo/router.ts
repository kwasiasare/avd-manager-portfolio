import type { DemoState } from './state';

/**
 * AM-60 — minimal path router for the demo transport. Mirrors the shape of
 * the real API's `route:` strings (`/v1/hostpools/:hostPoolName/...`) so each
 * registration reads like the Azure Function it stands in for.
 *
 * Every route has a `kind`:
 *  - 'read'      — a GET served from fixtures/state.
 *  - 'simulated' — a reversible mutation applied to in-memory state (and
 *                  audited); the UI shows "Simulated — not applied…".
 *  - 'disabled'  — a destructive/long-running action refused with 403
 *                  `demo_disabled` and a friendly message.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type RouteKind = 'read' | 'simulated' | 'disabled';

/** Raised by handlers; the transport converts it to an ApiClientError. */
export class DemoHttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DemoHttpError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new DemoHttpError(400, 'bad_request', message);
export const notFound = (message: string) => new DemoHttpError(404, 'not_found', message);
export const conflict = (message: string) => new DemoHttpError(409, 'conflict', message);

export function demoDisabled(what: string): DemoHttpError {
  return new DemoHttpError(403, 'demo_disabled', `${what} is disabled in the public demo — it would change real Azure resources. Everything else here is simulated in memory.`);
}

export interface RouteContext<TBody = unknown> {
  method: HttpMethod;
  params: Record<string, string>;
  query: URLSearchParams;
  body: TBody;
  state: DemoState;
}

export type RouteHandler<TRes = unknown, TBody = unknown> = (ctx: RouteContext<TBody>) => TRes | Promise<TRes>;

export interface RouteDef {
  key: string;
  method: HttpMethod;
  pattern: string;
  kind: RouteKind;
  segments: string[];
  handler: RouteHandler<unknown, never>;
}

const registry: RouteDef[] = [];

const splitPath = (path: string) => path.split('/').filter(Boolean);

function register(method: HttpMethod, pattern: string, kind: RouteKind, handler: RouteHandler<unknown, never>): void {
  const key = `${method} ${pattern}`;
  if (registry.some((def) => def.key === key)) {
    throw new Error(`Duplicate demo route ${key}`);
  }
  registry.push({ key, method, pattern, kind, segments: splitPath(pattern), handler });
}

/** GET served from fixtures/state. */
export function read<TRes>(pattern: string, handler: RouteHandler<TRes>): void {
  register('GET', pattern, 'read', handler as RouteHandler<unknown, never>);
}

/** POST used as a query (e.g. running a curated log view): reads state, mutates nothing the UI needs to flag as simulated. */
export function readPost<TRes, TBody = unknown>(pattern: string, handler: RouteHandler<TRes, TBody>): void {
  register('POST', pattern, 'read', handler as RouteHandler<unknown, never>);
}

/** Reversible mutation applied to in-memory state. */
export function simulate<TRes, TBody = unknown>(method: Exclude<HttpMethod, 'GET'>, pattern: string, handler: RouteHandler<TRes, TBody>): void {
  register(method, pattern, 'simulated', handler as RouteHandler<unknown, never>);
}

/** Destructive / long-running action: always 403 demo_disabled. */
export function disable(method: Exclude<HttpMethod, 'GET'>, pattern: string, what: string): void {
  register(method, pattern, 'disabled', () => {
    throw demoDisabled(what);
  });
}

export function listRoutes(): readonly RouteDef[] {
  return registry;
}

export function matchRoute(method: string, pathname: string): { def: RouteDef; params: Record<string, string> } | undefined {
  const segments = splitPath(pathname);
  for (const def of registry) {
    if (def.method !== method || def.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const want = def.segments[i];
      const got = segments[i];
      if (want.startsWith(':')) {
        try {
          params[want.slice(1)] = decodeURIComponent(got);
        } catch {
          params[want.slice(1)] = got;
        }
      } else if (want !== got) {
        ok = false;
        break;
      }
    }
    if (ok) return { def, params };
  }
  return undefined;
}

export interface DispatchResult {
  def: RouteDef;
  kind: RouteKind;
  data: unknown;
}

/** Splits `path?query`, matches a route, runs its handler. Unknown route -> 404 `demo_unmapped`. */
export async function dispatch(method: string, rawPath: string, body: unknown, state: DemoState): Promise<DispatchResult> {
  const upper = method.toUpperCase();
  const queryIndex = rawPath.indexOf('?');
  const pathname = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex === -1 ? '' : rawPath.slice(queryIndex + 1));
  const matched = matchRoute(upper, pathname);
  if (!matched) {
    throw new DemoHttpError(404, 'demo_unmapped', `The demo has no data for ${upper} ${pathname}.`);
  }
  const data = await (matched.def.handler as RouteHandler<unknown, unknown>)({ method: upper as HttpMethod, params: matched.params, query, body, state });
  return { def: matched.def, kind: matched.def.kind, data };
}
