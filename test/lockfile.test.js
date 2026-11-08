// test/lockfile.test.js — normalization of lockfile v1/v2/v3 + error classification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { loadLockfile, normalizeLockfile, LockfileError } from '../src/lockfile.js';

const fx = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));

test('v3: normalized record set with hasInstallScript, resolved host and nested keys', () => {
  const lock = loadLockfile(fx('lock-v3.json'));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.projectName, 'fixture-app');
  assert.equal(lock.records.length, 7);

  const byKey = new Map(lock.records.map((r) => [r.key, r]));
  const toolkit = byKey.get('node_modules/toolkit');
  assert.deepEqual(
    { name: toolkit.name, version: toolkit.version, hasInstallScript: toolkit.hasInstallScript, host: toolkit.host },
    { name: 'toolkit', version: '2.0.0', hasInstallScript: true, host: 'registry.npmjs.org' },
  );
  assert.ok(toolkit.resolved.endsWith('/toolkit-2.0.0.tgz'));
  assert.equal(byKey.get('node_modules/alpha/node_modules/shared').version, '0.9.0');
  // no flag recorded in the lockfile → unknown, never false (npm/cli#2606)
  assert.equal(byKey.get('node_modules/alpha').hasInstallScript, null);
  assert.equal(byKey.get('node_modules/devonly').hasInstallScript, true);
  assert.equal(byKey.get('node_modules/beta/node_modules/postcorg').name, 'postcorg');

  // stable internal record schema
  assert.deepEqual(Object.keys(lock.records[0]).sort(), ['dependencies', 'hasInstallScript', 'host', 'key', 'name', 'resolved', 'version']);
  // root dependencies merge prod + dev (npm ci installs both)
  assert.deepEqual(Object.keys(lock.rootDependencies).sort(), ['alpha', 'beta', 'devonly', 'toolkit']);
});

test('v2: packages map is preferred; records match the v3 view', () => {
  const v2 = loadLockfile(fx('lock-v2.json'));
  const v3 = loadLockfile(fx('lock-v3.json'));
  assert.equal(v2.lockfileVersion, 2);
  const triple = (l) => l.records.map((r) => `${r.key}|${r.name}|${r.version}|${r.hasInstallScript}`).sort();
  assert.deepEqual(triple(v2), triple(v3));
});

test('v1: nested tree is flattened; install-script flag is unknown (null)', () => {
  const lock = loadLockfile(fx('lock-v1.json'));
  assert.equal(lock.lockfileVersion, 1);
  assert.equal(lock.records.length, 4);
  const byKey = new Map(lock.records.map((r) => [r.key, r]));
  assert.equal(byKey.get('node_modules/oldhook/node_modules/oldcat').version, '1.9.0');
  for (const r of lock.records) assert.equal(r.hasInstallScript, null);
  assert.deepEqual(Object.keys(lock.rootDependencies).sort(), ['oldcat', 'oldhook', 'oldsafe']);
  assert.equal(byKey.get('node_modules/oldcat').dependencies.oldsafe, '^2.0.0');
});

test('error classification: missing / invalid / unknown-version', () => {
  const missingPath = path.join(tmpdir(), `scriptpeek-missing-${process.pid}-${Date.now()}`, 'package-lock.json');
  assert.throws(() => loadLockfile(missingPath), (err) => err instanceof LockfileError && err.kind === 'missing');
  assert.throws(() => loadLockfile(fx('lock-invalid.json')), (err) => err instanceof LockfileError && err.kind === 'invalid');
  assert.throws(() => loadLockfile(fx('lock-unknown.json')), (err) => err instanceof LockfileError && err.kind === 'unknown-version');
});

test('regression (npm/cli#2606): v3 entries stripped of the flag are unknown, not false', () => {
  const doc = JSON.parse(readFileSync(fx('lock-v3.json'), 'utf8'));
  for (const entry of Object.values(doc.packages)) delete entry.hasInstallScript;
  const dir = mkdtempSync(path.join(tmpdir(), 'scriptpeek-noflag-'));
  const file = path.join(dir, 'package-lock.json');
  writeFileSync(file, JSON.stringify(doc));
  const lock = loadLockfile(file);
  assert.equal(lock.records.length, 7);
  for (const r of lock.records) assert.equal(r.hasInstallScript, null);
});

test('explicit hasInstallScript true/false stays authoritative; absence is unknown', () => {
  const lock = normalizeLockfile({
    name: 'x', lockfileVersion: 3,
    packages: {
      '': { name: 'x', dependencies: {} },
      'node_modules/yes': { version: '1.0.0', hasInstallScript: true },
      'node_modules/no': { version: '1.0.0', hasInstallScript: false },
      'node_modules/maybe': { version: '1.0.0' },
    },
  });
  const flag = (k) => lock.nodes.get(k).hasInstallScript;
  assert.equal(flag('node_modules/yes'), true);
  assert.equal(flag('node_modules/no'), false);
  assert.equal(flag('node_modules/maybe'), null);
});

test('normalizeLockfile: empty v3 object yields zero records', () => {
  const lock = normalizeLockfile({ name: 'x', version: '1.0.0', lockfileVersion: 3, packages: {} });
  assert.deepEqual(lock.records, []);
  assert.deepEqual(lock.rootDependencies, {});
});

test('normalizeLockfile: v2 without packages falls back to the legacy tree', () => {
  const lock = normalizeLockfile({
    name: 'legacy', lockfileVersion: 2,
    dependencies: { solo: { version: '1.0.0', resolved: 'https://registry.npmjs.org/solo/-/solo-1.0.0.tgz' } },
  });
  assert.equal(lock.records.length, 1);
  assert.equal(lock.records[0].key, 'node_modules/solo');
  assert.deepEqual(Object.keys(lock.rootDependencies), ['solo']);
});
