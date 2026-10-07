import { computeScalingPhase } from '@avdmgr/shared';
import type { EstateSummaryResponse } from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { getCurrentScalingPlan, getHostPool, listSessionHosts } from './avdService';
import { computeHealthSummary } from './healthService';
import { listAlerts } from './alertsService';
import { extractAlertGuid, listAlertStates } from '../lib/alertState';
import { computeOverrideStatus, getScalingOverride } from './scalingOverrideService';

/** Matches the alert feed's own default lookback (see app/api/src/functions/alertsList.ts) — "open" alerts for the strip means "fired in the last day and not yet acked", not the full 7-day AM-24 feed window. */
const UNACKED_ALERT_LOOKBACK_HOURS = 24;

/**
 * Peer review (Opus, MAJOR item 5) — the EstateStrip polls this endpoint
 * from EVERY page (it lives in Layout, not one route), so N tabs/pages open
 * against the same Function App instance would otherwise each independently
 * trigger this function's own 6-call fan-out (host pool, session hosts,
 * alerts, alert states, scaling plan, override) on every poll tick. This
 * app manages exactly ONE host pool (see lib/config.ts's single
 * hostPoolName), so a single-key, in-process cache is enough — no need for
 * a cache keyed by host pool name.
 *
 * ~45s: comfortably under the EstateStrip's own poll interval (60s, see
 * frontend EstateStrip.tsx) so the strip still reflects a fetch from
 * roughly its last poll, while collapsing the common case of several tabs
 * polling within a few seconds of each other into one fan-out.
 */
const CACHE_TTL_MS = 45_000;

let cachedSummary: { value: EstateSummaryResponse; expiresAt: number } | undefined;
/** Dedupes concurrent callers arriving while a fetch is already in flight (e.g. two tabs polling at nearly the same instant) onto the SAME underlying fan-out, rather than each starting their own. */
let inFlightFetch: Promise<EstateSummaryResponse> | undefined;

/** True when every segment failed — see getEstateSummary's "never cache a fully-failed result" rule below. */
function isFullyFailed(response: EstateSummaryResponse): boolean {
  return (
    response.hosts === undefined &&
    response.sessions === undefined &&
    response.openAlertCount === undefined &&
    response.scalingPhase === undefined &&
    response.overrideActive === undefined
  );
}

/**
 * Peer review (Opus, MINOR item 15) — when a segment is genuinely down
 * (e.g. ARM unreachable), EVERY uncached poll from EVERY tab would otherwise
 * log its own warning for the same underlying failure — a fully-failed
 * result is deliberately never cached (see isFullyFailed), so without this,
 * a sustained outage would spam the Function App's log stream once per poll
 * per tab. Rate-limited per SEGMENT (not globally) so one failing segment
 * doesn't suppress a genuinely new failure in a different segment.
 */
const WARN_RATE_LIMIT_MS = 5 * 60_000;
const lastWarnAtBySegment = new Map<string, number>();

function warnRateLimited(warn: (message: string) => void, segment: string, message: string): void {
  const now = Date.now();
  const last = lastWarnAtBySegment.get(segment);
  if (last !== undefined && now - last < WARN_RATE_LIMIT_MS) {
    return;
  }
  lastWarnAtBySegment.set(segment, now);
  warn(message);
}

function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Counts alerts fired in the last UNACKED_ALERT_LOOKBACK_HOURS with no
 * app-level ack recorded (see app/api/src/lib/alertState.ts#applyAlertState
 * for the same ackedBy/ackedAt-present rule alertsList.ts uses to decide
 * whether to surface ack badges). A snoozed-but-unacked alert still counts
 * as open here — snooze only defers where it's shown elsewhere in the UI,
 * it is not an acknowledgement.
 */
async function countOpenAlerts(): Promise<number> {
  const alerts = await listAlerts(UNACKED_ALERT_LOOKBACK_HOURS);

  let states: Map<string, { ackedBy?: string; ackedAt?: string }>;
  try {
    states = await listAlertStates();
  } catch {
    // Same degrade-to-"no overlay" posture as alertsList.ts: an AlertState
    // lookup failure must not make every alert count as open OR closed by
    // guesswork — it just means no alert in this batch can be confirmed
    // acked, which (correctly) counts every one of them as open.
    states = new Map();
  }

  let openCount = 0;
  for (const alert of alerts) {
    const guid = extractAlertGuid(alert.id);
    const state = guid ? states.get(guid) : undefined;
    const acked = Boolean(state?.ackedBy && state?.ackedAt);
    if (!acked) {
      openCount += 1;
    }
  }
  return openCount;
}

/**
 * The actual 6-call fan-out — host pool, session hosts, alerts, alert
 * states, scaling plan, and override — split out from getEstateSummary so
 * that function can wrap it in the TTL cache / in-flight dedup without this
 * body needing to know anything about caching.
 */
async function computeEstateSummary(warn: (message: string) => void): Promise<EstateSummaryResponse> {
  const { hostPoolName } = getConfig();

  const [hostsResult, alertResult, phaseResult, overrideResult] = await Promise.allSettled([
    (async () => {
      const [hostPool, sessionHosts] = await Promise.all([
        getHostPool(hostPoolName),
        // resolvePowerState: false — the strip only needs status/allowNewSession/
        // activeSessions (see computeHealthSummary), same rationale as
        // app/api/src/functions/healthSummary.ts: skip the extra @azure/arm-compute
        // instanceView call per host on every 60s strip poll.
        listSessionHosts(hostPoolName, { warn, resolvePowerState: false }),
      ]);
      return computeHealthSummary(hostPoolName, sessionHosts, hostPool?.maxSessionLimit);
    })(),
    countOpenAlerts(),
    (async () => {
      const plan = await getCurrentScalingPlan();
      return plan ? computeScalingPhase(plan) : undefined;
    })(),
    (async () => {
      const record = await getScalingOverride();
      return computeOverrideStatus(record).active;
    })(),
  ]);

  const response: EstateSummaryResponse = {
    generatedAt: new Date().toISOString(),
    hostPoolName,
  };

  if (hostsResult.status === 'fulfilled') {
    response.hosts = { available: hostsResult.value.available, total: hostsResult.value.total };
    response.sessions = { used: hostsResult.value.sessionsUsed, capacity: hostsResult.value.sessionsMax };
  } else {
    warnRateLimited(warn, 'hosts', `estate summary: host/session lookup failed: ${describeError(hostsResult.reason)}`);
  }

  if (alertResult.status === 'fulfilled') {
    response.openAlertCount = alertResult.value;
  } else {
    warnRateLimited(warn, 'alerts', `estate summary: open alert count lookup failed: ${describeError(alertResult.reason)}`);
  }

  if (phaseResult.status === 'fulfilled') {
    response.scalingPhase = phaseResult.value;
  } else {
    warnRateLimited(warn, 'scalingPhase', `estate summary: scaling phase lookup failed: ${describeError(phaseResult.reason)}`);
  }

  if (overrideResult.status === 'fulfilled') {
    response.overrideActive = overrideResult.value;
  } else {
    warnRateLimited(warn, 'override', `estate summary: override status lookup failed: ${describeError(overrideResult.reason)}`);
  }

  return response;
}

/**
 * Aggregates the data behind the EstateStrip (AM-29 item 26,
 * GET /v1/estate/summary) — host/session health, current scaling phase,
 * open alert count, and emergency-override state. Every segment is fetched
 * independently via Promise.allSettled and populated ONLY on success; a
 * failed segment is simply omitted from the response (not defaulted to a
 * fabricated zero/false), so the strip can render "—" for exactly the
 * segment that failed while the rest keep working. `warn` is called (rate-
 * limited per segment — see warnRateLimited) with the underlying error, for
 * operational visibility — this function itself never throws.
 *
 * Peer review (Opus, MAJOR item 5) — wrapped in a ~45s single-key
 * in-process cache plus in-flight-call dedup (see CACHE_TTL_MS's doc
 * comment): a FULLY failed result (every segment failed — see
 * isFullyFailed) is never cached, so a genuine outage is retried on the
 * very next call rather than serving (or re-warning about) a dead result
 * for the full TTL window.
 */
export async function getEstateSummary(warn: (message: string) => void = () => {}): Promise<EstateSummaryResponse> {
  const now = Date.now();
  if (cachedSummary && cachedSummary.expiresAt > now) {
    return cachedSummary.value;
  }

  if (!inFlightFetch) {
    inFlightFetch = computeEstateSummary(warn).finally(() => {
      inFlightFetch = undefined;
    });
  }

  const result = await inFlightFetch;
  cachedSummary = isFullyFailed(result) ? undefined : { value: result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}
