import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, FIXTURE_MARKER } from './check-demo-bundle.mjs';

function fixtureDir(content) {
  const dir = mkdtempSync(join(tmpdir(), 'demo-bundle-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index.js'), content);
  return dir;
}

test('absent: passes when no marker is present', () => {
  assert.deepEqual(check({ absent: [fixtureDir('console.log("real app")')] }), []);
});

test('absent: fails when the fixture marker leaked', () => {
  const errors = check({ absent: [fixtureDir(`var a="${FIXTURE_MARKER}"`)] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /leaked/);
});

test('absent: fails when demo banner copy leaked', () => {
  assert.equal(check({ absent: [fixtureDir('fictional Contoso estate')] }).length, 1);
});

test('present: passes when the marker is bundled, fails when not', () => {
  assert.deepEqual(check({ present: [fixtureDir(`x="${FIXTURE_MARKER}"`)] }), []);
  assert.equal(check({ present: [fixtureDir('nothing')] }).length, 1);
});

test('missing directories are reported', () => {
  assert.equal(check({ absent: ['/nonexistent/dist'] }).length, 1);
});
