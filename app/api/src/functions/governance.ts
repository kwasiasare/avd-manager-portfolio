import { createHash, randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, GovernanceCheckResult, GovernanceSummary } from '@avdmgr/shared';
import type { ClientPrincipal } from '../lib/auth';
import { requireMinimumRole } from '../lib/auth';
import { getGovernanceSummary } from '../services/governanceService';

const CA_POLICY_CHECK_ID = 'ca-policy-breakglass';

/**
 * Role hierarchy check WITHOUT re-invoking requireMinimumRole a second time
 * (which would re-verify the backend secret and, on denial, log a second
 * "auth denied" warning for what is really a single request) — the caller
 * already passed the viewer+ gate below; this just asks whether they also
 * clear the operator bar, using the SAME case-insensitive-trim
 * normalization app/api/src/lib/auth.ts's own requireRoleImpl applies to
 * userRoles.
 */
function isOperatorOrAbove(principal: ClientPrincipal): boolean {
  const roles = principal.userRoles.map((role) => role.trim().toLowerCase());
  return roles.includes('operator') || roles.includes('admin');
}

/**
 * Stable, non-reversible per-policy label (peer review item 15) — a short
 * hash of the policy's own (opaque, non-secret) GUID id, NOT of its
 * displayName, so the label can't be worked backward into the name it's
 * standing in for. `Policy-XXXXXXXX` rather than a bare hash so it reads
 * as a label, not a stray hex string, in the UI.
 */
function stablePolicyLabel(policyId: string): string {
  return `Policy-${createHash('sha256').update(policyId).digest('hex').slice(0, 8)}`;
}

interface RedactablePolicyEvidence {
  id?: string;
  displayName?: string;
  [key: string]: unknown;
}

function redactPolicyList(policies: unknown): unknown {
  if (!Array.isArray(policies)) return policies;
  return policies.map((policy) => {
    const p = policy as RedactablePolicyEvidence;
    if (typeof p.id !== 'string') return policy;
    return { ...p, displayName: stablePolicyLabel(p.id) };
  });
}

/**
 * Redacts the CA-policy-exclusion check's evidence (policy displayNames,
 * and the matching link labels) down to a stable generic label for
 * viewer-role callers — peer review item 15: a Conditional Access policy's
 * displayName can itself be sensitive (naming internal groups/roles/
 * posture details), so only operator+ callers see it verbatim. The
 * check's pass/warn/fail STATUS, summary, and counts are never redacted —
 * only the per-policy names. Returns a NEW GovernanceSummary (never
 * mutates the input) — `summary` may be the SAME cached object multiple
 * concurrent viewer AND operator+ requests share, so mutating it in place
 * would leak (or wrongly redact) evidence across callers.
 */
export function redactConditionalAccessEvidenceForViewers(summary: GovernanceSummary): GovernanceSummary {
  const index = summary.checks.findIndex((check) => check.id === CA_POLICY_CHECK_ID);
  if (index === -1) return summary;

  const original = summary.checks[index];
  const evidence = original.evidence as { policies?: unknown; reportOnlyPolicies?: unknown; [key: string]: unknown };
  if (!('policies' in evidence) && !('reportOnlyPolicies' in evidence)) return summary;

  const redactedCheck: GovernanceCheckResult = {
    ...original,
    evidence: { ...evidence, policies: redactPolicyList(evidence.policies), reportOnlyPolicies: redactPolicyList(evidence.reportOnlyPolicies) },
    links: original.links?.map((link) => {
      const match = /Review "(.+)" in Entra/.exec(link.label);
      if (!match) return link;
      const idFromUrl = link.url.split('/').pop();
      return { ...link, label: idFromUrl ? `Review "${stablePolicyLabel(idFromUrl)}" in Entra` : link.label };
    }),
  };

  const checks = [...summary.checks];
  checks[index] = redactedCheck;
  return { ...summary, checks };
}

/**
 * GET /v1/governance — AM-16 (M3b) Governance & security posture panel.
 * Viewer+ (read-only — this page surfaces posture findings, it never
 * mutates anything). `?refresh=true` bypasses the ~10min server-side cache
 * (see governanceService.ts's getGovernanceSummary doc comment for why this
 * page's refresh button is special-cased that way, unlike every other
 * read-only endpoint here) — GATED TO OPERATOR+ (peer review item 10): a
 * forced re-run fans out to dozens of ARM/Graph calls, materially more
 * expensive than a cached read, so a viewer can load the page but not
 * trigger that cost; governanceService.ts's own MIN_REFRESH_INTERVAL_MS
 * additionally floors how often even an operator+ caller can force one.
 * `Cache-Control: no-store` (peer review item 10) on every response — this
 * payload can include governance/security posture findings and must never
 * be cached by an intermediary or the browser's own HTTP cache, independent
 * of this app's own server-side cache above.
 */
export async function governance(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const refreshRequested = request.query.get('refresh') === 'true';
  if (refreshRequested && !isOperatorOrAbove(authResult.principal)) {
    context.warn(`governance refresh denied: viewer role cannot force a refresh | principal=${authResult.principal.userId}`);
    return {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { status: 403, code: 'forbidden', message: "Refresh requires at least the 'operator' role." } satisfies ApiError,
    };
  }

  try {
    let summary: GovernanceSummary = await getGovernanceSummary({
      forceRefresh: refreshRequested,
      warn: (message) => context.warn(message),
      log: (message) => context.log(message),
      error: (message, err) => context.error(message, err),
    });

    if (!isOperatorOrAbove(authResult.principal)) {
      summary = redactConditionalAccessEvidenceForViewers(summary);
    }

    return { status: 200, headers: { 'Cache-Control': 'no-store' }, jsonBody: summary };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`governance summary failed | forceRefresh=${refreshRequested} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'governance_summary_failed',
      message: `Failed to compute the governance summary. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, headers: { 'Cache-Control': 'no-store' }, jsonBody: apiError };
  }
}

app.http('governance', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/governance',
  handler: governance,
});
