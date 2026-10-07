// Bundle guard for demo mode (AM-60). The demo transport + fixtures must ship
// ONLY in dist-demo/, never in the real app's dist/.
//
//   node scripts/check-demo-bundle.mjs                       -> checks dist (absent) and dist-demo (present) when they exist
//   node scripts/check-demo-bundle.mjs --absent dist         -> fail if dist/ contains any demo marker
//   node scripts/check-demo-bundle.mjs --present dist-demo   -> fail if dist-demo/ lacks the fixture marker
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Sentinel exported from src/demo/transport.ts (DEMO_FIXTURE_MARKER) — only present when the demo transport is bundled. */
export const FIXTURE_MARKER = 'DEMO_FIXTURE_MARKER_a7c1';
/**
 * Belt-and-braces proof that no demo module leaked into a normal build: the
 * transport marker, visible banner copy, a fixture identifier, and (AM-60
 * review fix) one literal each from the two small demo modules that are
 * imported statically — identity.ts (sessionStorage key) and router.ts
 * (error code) — which the fixture markers alone would not catch.
 */
export const ABSENT_MARKERS = [FIXTURE_MARKER, 'fictional Contoso estate', 'ACG_AVD_CONTOSO', 'avdmgr-demo-role', 'demo_disabled'];

const TEXT_EXT = /\.(js|mjs|css|html|json|map|txt)$/i;

export function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Returns { marker, file } for every marker found in any text file under dir. */
export function findMarkers(dir, markers) {
  const hits = [];
  for (const file of walk(dir)) {
    if (!TEXT_EXT.test(file)) continue;
    const text = readFileSync(file, 'utf-8');
    for (const marker of markers) {
      if (text.includes(marker)) hits.push({ marker, file });
    }
  }
  return hits;
}

export function check({ absent = [], present = [] }) {
  const errors = [];
  for (const dir of absent) {
    if (!existsSync(dir)) {
      errors.push(`${dir} does not exist (build it first)`);
      continue;
    }
    for (const hit of findMarkers(dir, ABSENT_MARKERS)) errors.push(`${dir}: demo marker "${hit.marker}" leaked into ${hit.file}`);
  }
  for (const dir of present) {
    if (!existsSync(dir)) {
      errors.push(`${dir} does not exist (build it first)`);
      continue;
    }
    if (findMarkers(dir, [FIXTURE_MARKER]).length === 0) errors.push(`${dir}: fixture marker "${FIXTURE_MARKER}" not found — demo transport was not bundled`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const options = { absent: [], present: [] };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag !== '--absent' && flag !== '--present') || !value) {
      console.error('usage: check-demo-bundle.mjs [--absent <dir>]... [--present <dir>]...');
      process.exit(2);
    }
    options[flag.slice(2)].push(resolve(root, value));
  }
  if (args.length === 0) {
    if (existsSync(resolve(root, 'dist'))) options.absent.push(resolve(root, 'dist'));
    if (existsSync(resolve(root, 'dist-demo'))) options.present.push(resolve(root, 'dist-demo'));
  }
  const errors = check(options);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[check-demo-bundle] FAIL: ${error}`);
    process.exit(1);
  }
  console.log(`[check-demo-bundle] ok (absent: ${options.absent.length} dir(s), present: ${options.present.length} dir(s))`);
}
