import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from './scan-denylist.mjs';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test('flags a denylisted term with file:line', () => {
  const dir = fixture({ 'a.txt': 'ok\nthis mentions Acme-Secret here\n' });
  const list = join(fixture({ 'l.txt': 'acme-secret\n' }), 'l.txt');
  const hits = scan(dir, { denylistFile: list });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'a.txt');
  assert.equal(hits[0].line, 2);
});

test('flags an unlisted GUID but allows the fake pattern', () => {
  const dir = fixture({
    'bad.txt': `id ${['deadbeef', '0000', '4000', '8000', '123456789abc'].join('-')}\n`,
    'good.txt': 'id 00000000-0000-4000-8000-000000000001\n',
  });
  const hits = scan(dir, {});
  assert.deepEqual(hits.map((h) => h.file), ['bad.txt']);
});

test('flags a non-example email address', () => {
  const dir = fixture({ 'm.txt': `mail someone@${'realcorp'}.com\nmail a@contoso.example\n` });
  const hits = scan(dir, {});
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('clean tree has no hits', () => {
  assert.equal(scan(fixture({ 'c.txt': 'hello world\n' }), {}).length, 0);
});
