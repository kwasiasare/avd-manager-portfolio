import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getBuildInfo } from '../lib/buildInfo';

/**
 * AM-54 — `version` now comes from the CI-stamped build artifact
 * (`version.json`, written by the API deploy pipeline's "Assemble self-contained API
 * package" step), not the operator-maintained API_VERSION app setting —
 * see `app/api/src/lib/buildInfo.ts`'s doc comment for the full motivation
 * and fallback behavior. `version` stays the top-level key it always was
 * (back-compat for anything already reading it); `gitSha`/`builtAt` are new
 * and only present when the artifact provided them; `versionSource` says
 * which of the two sources actually served this response.
 */
export async function health(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const buildInfo = getBuildInfo();

  return {
    status: 200,
    jsonBody: {
      status: 'ok',
      version: buildInfo.version,
      ...(buildInfo.gitSha !== undefined ? { gitSha: buildInfo.gitSha } : {}),
      ...(buildInfo.builtAt !== undefined ? { builtAt: buildInfo.builtAt } : {}),
      versionSource: buildInfo.source,
    },
  };
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/health',
  handler: health,
});
