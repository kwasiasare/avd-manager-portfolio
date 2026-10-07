import type { GovernanceSummary, LogsQueryResponse, LogsViewSummary, RawKqlRequest } from '@avdmgr/shared';
import { buildGovernance, summarize } from '../fixtures/governance';
import { buildRawKqlNote, buildViewResult, LOG_VIEWS } from '../fixtures/logs';
import { badRequest, notFound, read, readPost } from '../router';

/** Log views and governance: canned, read-only. Raw KQL is never executed — it returns a note table. */
export function registerLogsGovernanceRoutes(): void {
  // --- logs (canned) ---
  read<LogsViewSummary[]>('/v1/logs/views', () => LOG_VIEWS.slice());

  readPost<LogsQueryResponse, { timespanHours?: number }>('/v1/logs/views/:viewId/run', ({ params, state }) => {
    const result = buildViewResult(params.viewId, state.now);
    if (!result) throw notFound(`Unknown log view "${params.viewId}".`);
    return result;
  });

  readPost<LogsQueryResponse, RawKqlRequest>('/v1/logs/query', ({ body }) => {
    if (!body?.kql?.trim()) throw badRequest('A KQL query is required.');
    return buildRawKqlNote(body.kql);
  });

  // --- governance ---
  read<GovernanceSummary>('/v1/governance', ({ query, state }) => {
    const summary = buildGovernance(state.now);
    return query.get('refresh') === 'true' ? summary : summarize(summary.checks, state.now, true);
  });
}
