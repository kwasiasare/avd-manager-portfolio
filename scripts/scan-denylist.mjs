#!/usr/bin/env node
// Scans the repository tree for identifying data that must never be committed.
//
// Sources of patterns (merged):
//   1. scripts/denylist.example.txt            (committed, generic)
//   2. $DENYLIST_FILE, else scripts/denylist.local.txt  (private, gitignored; optional)
//   3. A generic GUID heuristic: any GUID not matched by scripts/guid-allowlist.txt
//
// Exit code 1 (with file:line for every hit) on any finding. No dependencies.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.deploy-stage']);
const SKIP_FILES = new Set(['package-lock.json']);
const GUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function readList(file) {
  return readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function compileEntry(entry) {
  if (entry.startsWith('re:')) return { label: entry, test: (line) => new RegExp(entry.slice(3), 'i').test(line) };
  const needle = entry.toLowerCase();
  return { label: entry, test: (line) => line.toLowerCase().includes(needle) };
}

function loadAllowlist(file) {
  const exact = new Set();
  const regexes = [];
  for (const e of existsSync(file) ? readList(file) : []) {
    if (e.startsWith('re:')) regexes.push(new RegExp(e.slice(3), 'i'));
    else exact.add(e.toLowerCase());
  }
  return (guid) => exact.has(guid.toLowerCase()) || regexes.some((r) => r.test(guid.toLowerCase()));
}

function* walk(dir, excluded) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (excluded.has(resolve(full))) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(full, excluded);
    } else if (st.isFile() && !SKIP_FILES.has(name)) {
      yield full;
    }
  }
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * @param {string} root directory to scan
 * @param {{denylistFile?: string, exampleFile?: string, allowlistFile?: string}} [opts]
 * @returns {{file: string, line: number, rule: string, text: string}[]}
 */
export function scan(root, opts = {}) {
  const exampleFile = opts.exampleFile ?? join(here, 'denylist.example.txt');
  const localFile = join(here, 'denylist.local.txt');
  const privateFile = opts.denylistFile ?? (existsSync(localFile) ? localFile : undefined);
  const allowlistFile = opts.allowlistFile ?? join(here, 'guid-allowlist.txt');

  const entries = [...(existsSync(exampleFile) ? readList(exampleFile) : [])];
  if (privateFile) entries.push(...readList(privateFile));
  const rules = entries.map(compileEntry);
  const guidAllowed = loadAllowlist(allowlistFile);

  // The private denylist files describe what to hide, so they must never be scanned themselves.
  const excluded = new Set([resolve(here, 'denylist.txt'), resolve(localFile)]);
  if (privateFile) excluded.add(resolve(privateFile));

  const hits = [];
  for (const file of walk(root, excluded)) {
    const buf = readFileSync(file);
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf-8').split(/\r?\n/);
    const rel = relative(root, file).split(sep).join('/');
    lines.forEach((text, i) => {
      for (const rule of rules) {
        if (rule.test(text)) hits.push({ file: rel, line: i + 1, rule: rule.label, text: text.trim().slice(0, 160) });
      }
      for (const m of text.matchAll(GUID_RE)) {
        if (!guidAllowed(m[0])) hits.push({ file: rel, line: i + 1, rule: `unlisted GUID ${m[0]}`, text: text.trim().slice(0, 160) });
      }
    });
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(here, '..'));
  const denylistFile = process.env.DENYLIST_FILE ? resolve(process.env.DENYLIST_FILE) : undefined;
  if (denylistFile && !existsSync(denylistFile)) {
    console.error(`DENYLIST_FILE not found: ${denylistFile}`);
    process.exit(2);
  }
  const hits = scan(root, { denylistFile });
  const mode = denylistFile ?? (existsSync(join(here, 'denylist.local.txt')) ? 'scripts/denylist.local.txt' : 'example list + GUID heuristic only');
  if (hits.length === 0) {
    console.log(`scan: 0 hits (${mode})`);
  } else {
    for (const h of hits) console.error(`${h.file}:${h.line}: [${h.rule}] ${h.text}`);
    console.error(`scan: ${hits.length} hit(s) (${mode})`);
    process.exit(1);
  }
}
