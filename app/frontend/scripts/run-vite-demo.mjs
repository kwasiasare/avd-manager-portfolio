// Shared by build-demo.mjs / dev-demo.mjs: runs the local vite binary with the
// demo build-time env (VITE_DEMO_MODE=true), cross-platform (no `VAR=x cmd`).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const frontendRoot = resolve(here, '..');

export const DEMO_ENV = { VITE_DEMO_MODE: 'true', VITE_HOSTPOOL_NAME: 'HP-CONTOSO-PROD' };

export function runVite(args) {
  const require = createRequire(import.meta.url);
  const viteBin = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const result = spawnSync(process.execPath, [viteBin, ...args], {
    cwd: frontendRoot,
    stdio: 'inherit',
    env: { ...process.env, ...DEMO_ENV },
  });
  return result.status ?? 1;
}
