import { ApiClientError, type ApiFetchOptions } from '../api/client';
import { markSimulated } from './simulatedSignal';
import { DemoHttpError, dispatch } from './router';
import { registerAllRoutes } from './routes';
import { getDemoState } from './state';

/**
 * Sentinel asserted by scripts/check-demo-bundle.mjs: it MUST appear in
 * dist-demo/ and MUST NOT appear in a normal dist/ build (proving the
 * lazily imported demo code is tree-shaken out of production).
 */
export const DEMO_FIXTURE_MARKER = 'DEMO_FIXTURE_MARKER_a7c1';

let latency: (path: string) => number = pseudoLatencyMs;

/** Deterministic 120–350 ms "network" delay seeded from the path (keeps AsyncState's 3 s cold-start hint silent). */
export function pseudoLatencyMs(path: string): number {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) {
    hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  }
  return 120 + (Math.abs(hash) % 231);
}

/** Tests override the delay (e.g. `() => 0`); pass undefined to restore the default. */
export function setDemoLatency(fn: ((path: string) => number) | undefined): void {
  latency = fn ?? pseudoLatencyMs;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Drop-in replacement for the network leg of apiFetch (see api/client.ts):
 * same `(path, options)` contract, same ApiClientError failure shape, but
 * answered from the in-memory demo state. A JSON round trip on the result
 * hands callers a private copy, exactly as a real response would.
 */
export async function demoFetch<TResponse>(path: string, options: ApiFetchOptions = {}): Promise<TResponse> {
  registerAllRoutes();
  // Referenced at runtime so the bundler can never drop the marker the bundle guard looks for.
  (globalThis as { __AVDMGR_DEMO__?: string }).__AVDMGR_DEMO__ = DEMO_FIXTURE_MARKER;
  const { method = 'GET', body, signal } = options;
  await delay(latency(path), signal);
  try {
    const result = await dispatch(method, path, body, getDemoState());
    if (result.kind === 'simulated') markSimulated();
    return (result.data === undefined ? undefined : JSON.parse(JSON.stringify(result.data))) as TResponse;
  } catch (error) {
    if (error instanceof DemoHttpError) {
      throw new ApiClientError({ status: error.status, code: error.code, message: error.message });
    }
    throw error;
  }
}
