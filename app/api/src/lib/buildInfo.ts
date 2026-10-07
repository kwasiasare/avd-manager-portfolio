import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';

/**
 * AM-54 — honest `/v1/health` (and `/v1/settings`) version reporting.
 *
 * Before this, both endpoints only ever reported the bicep-fed API_VERSION
 * app setting (`getConfig().apiVersion`) — an operator-maintained string
 * that has nothing to do with what code is actually running. It drifted
 * silently: prod reported `1.0.0` all the way through the 1.1.x line.
 * Motivating incident: during the endOfLifeDate fix deploy (see
 * the project changelog), prod's running code version could not be confirmed
 * from the app itself — only by cross-referencing the deploy workflow run.
 *
 * The API deploy pipeline's (not part of this repository) "Assemble self-contained API
 * package" step now writes a `version.json` (package.json's `version`,
 * the deploying commit's `gitSha`, and a `builtAt` ISO timestamp) into the
 * SAME staged directory that becomes the deployed artifact — so
 * version.json always describes the exact code it ships alongside, not a
 * separately-maintained setting.
 */
export interface BuildInfo {
  version: string;
  gitSha?: string;
  builtAt?: string;
  /**
   * 'artifact' — version.json was present, well-formed, and used.
   * 'app-setting' — version.json was missing/unreadable/malformed for any
   * reason, and this fell back to the API_VERSION app setting instead. Local
   * dev (no CI-assembled package on disk) and any environment that predates
   * this story both land here.
   */
  source: 'artifact' | 'app-setting';
}

interface RawVersionFile {
  version: string;
  gitSha?: string;
  builtAt?: string;
}

/**
 * This function is the FIRST place app/api reads a file off the deployed
 * package at runtime — every other config source is `process.env` (see
 * `config.ts`). Cached at module scope after the first successful (or
 * fallen-back) read: envs don't change at runtime and this file never
 * changes underneath a running process, so there's no reason to re-read it
 * on every `/v1/health` hit. `_resetBuildInfoForTests` clears the cache so
 * each test can exercise a fresh read.
 */
let cachedBuildInfo: BuildInfo | undefined;

/** Test-only seam — clears the module-level cache so a test can force a fresh read (and, typically, a fresh `fs.readFileSync` mock) on its next `getBuildInfo()` call. */
export function _resetBuildInfoForTests(): void {
  cachedBuildInfo = undefined;
}

/**
 * Resolves the deployed package's root directory relative to THIS compiled
 * file's own location (`__dirname`), not `process.cwd()`. `__dirname` is
 * deterministic — it's baked into the compiled `dist/src/lib/buildInfo.js`
 * at build time and points at wherever that file physically sits on disk,
 * regardless of how or from where the Functions host process was launched.
 * `process.cwd()` has no such guarantee: it reflects whatever directory the
 * host process happened to be started from, which is an Azure Functions
 * hosting-model implementation detail this app has no control over and no
 * reason to depend on for something as basic as "where is my own package
 * root."
 *
 * The hop itself: `tsconfig.json` compiles with `rootDir: '.'`, so
 * `src/lib/buildInfo.ts` lands at `dist/src/lib/buildInfo.js`. Three `..`
 * segments walk dist/src/lib -> dist/src -> dist -> the package root
 * (where `version.json`, `host.json`, and `package.json` all live side by
 * side — see the deploy pipeline's "Assemble self-contained API package" step).
 */
function resolvePackageRoot(): string {
  return path.join(__dirname, '..', '..', '..');
}

function isValidRawVersionFile(value: unknown): value is RawVersionFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.version !== 'string' || candidate.version.trim().length === 0) {
    return false;
  }
  if (candidate.gitSha !== undefined && typeof candidate.gitSha !== 'string') {
    return false;
  }
  if (candidate.builtAt !== undefined && typeof candidate.builtAt !== 'string') {
    return false;
  }
  return true;
}

/**
 * Reads and validates `<packageRoot>/version.json`, falling back to
 * `{ version: getConfig().apiVersion, source: 'app-setting' }` on ANY
 * failure — missing file (local dev, or a deploy predating AM-54), invalid
 * JSON, or a well-formed-JSON-but-wrong-shape file. This NEVER throws: it
 * feeds an anonymous, unauthenticated health endpoint
 * (`app/api/src/functions/health.ts`), and a health check that can itself
 * fail closed on a malformed build artifact would defeat the point of
 * having one. The `getConfig()` fallback call is in its OWN try/catch,
 * deliberately separate from the version.json read above — `getConfig()`
 * throws on a genuinely unconfigured environment (missing SUBSCRIPTION_ID/
 * RG_HOSTPOOLS/HOSTPOOL_NAME, none of which have fallbacks — see
 * `config.ts`), and that failure must not propagate out of here either;
 * `'unknown'` is the last-resort value when even that fallback isn't
 * available.
 */
export function getBuildInfo(): BuildInfo {
  if (cachedBuildInfo) {
    return cachedBuildInfo;
  }

  try {
    const versionJsonPath = path.join(resolvePackageRoot(), 'version.json');
    const raw = fs.readFileSync(versionJsonPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    if (!isValidRawVersionFile(parsed)) {
      throw new Error(`version.json at ${versionJsonPath} has an unexpected shape`);
    }

    cachedBuildInfo = {
      version: parsed.version,
      gitSha: parsed.gitSha,
      builtAt: parsed.builtAt,
      source: 'artifact',
    };
    return cachedBuildInfo;
  } catch {
    // Missing file, unreadable, invalid JSON, or wrong shape — all treated
    // identically: fall back to the app-setting-fed version rather than
    // ever throwing out of a health check.
  }

  try {
    cachedBuildInfo = { version: getConfig().apiVersion, source: 'app-setting' };
  } catch {
    cachedBuildInfo = { version: 'unknown', source: 'app-setting' };
  }

  return cachedBuildInfo;
}
