// `npm run build:demo` — builds the public, anonymous, frontend-only demo into dist-demo/.
//  1. vite build with VITE_DEMO_MODE=true (demo transport + fixtures bundled in)
//  2. replace staticwebapp.config.json with the anonymous demo variant (no auth block / 401 overrides)
//  3. drop access-pending.html (the real app's "no role" landing page; unreachable in the demo)
//  4. assert the demo bundle really contains the demo fixtures
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { frontendRoot, runVite } from './run-vite-demo.mjs';

const outDir = resolve(frontendRoot, 'dist-demo');

const status = runVite(['build', '--outDir', 'dist-demo', '--emptyOutDir']);
if (status !== 0) process.exit(status);

copyFileSync(resolve(frontendRoot, 'demo/staticwebapp.config.json'), resolve(outDir, 'staticwebapp.config.json'));
const pending = resolve(outDir, 'access-pending.html');
if (existsSync(pending)) rmSync(pending);
console.log(`[build-demo] wrote ${outDir}`);

const guard = spawnSync(process.execPath, [resolve(frontendRoot, 'scripts/check-demo-bundle.mjs'), '--present', 'dist-demo'], { cwd: frontendRoot, stdio: 'inherit' });
process.exit(guard.status ?? 1);
