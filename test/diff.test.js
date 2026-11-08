// test/diff.test.js — the three event types over synthetic fixture pairs,
// plus exit-code semantics (1 only for added script packages; --no-fail forces 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadLockfile, normalizeLockfile } from '../src/lockfile.js';
import { diffRecords, diffExitCode } from '../src/diff.js';

const fx = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const load = (f) => loadLockfile(fx(f));

test('added script package: high-severity event, exit 1, --no-fail forces 0', () => {
  const events = diffRecords(load('diff-base.json'), load('diff-new-added-script.json'));
  assert.deepEqual(events, [
    { type: 'added-script-package', name: 'sneakyinstall', severity: 'high', from: null, to: '2.0.0' },
  ]);
  assert.equal(diffExitCode(events), 1);
  assert.equal(diffExitCode(events, { noFail: true }), 0);
});

test('added plain package: no events, exit 0', () => {
  const events = diffRecords(load('diff-base.json'), load('diff-new-added-plain.json'));
  assert.deepEqual(events, []);
  assert.equal(diffExitCode(events), 0);
});

test('script package version bump: version-change event, exit 0', () => {
  const events = diffRecords(load('diff-base.json'), load('diff-new-version-change.json'));
  assert.deepEqual(events, [
    { type: 'version-change', name: 'hooklib', severity: 'high', from: '1.0.0', to: '1.1.0' },
  ]);
  assert.equal(diffExitCode(events), 0);
});

test('resolved registry host change: registry-change event, exit 0', () => {
  const events = diffRecords(load('diff-base.json'), load('diff-new-registry-change.json'));
  assert.deepEqual(events, [
    { type: 'registry-change', name: 'keeper', severity: 'high', from: 'registry.npmjs.org', to: 'evil.example.com' },
  ]);
  assert.equal(diffExitCode(events), 0);
});

test('resolved origin repointed to a file: tarball: registry-change with null host, exit 0', () => {
  const events = diffRecords(load('diff-base.json'), load('diff-new-origin-removed.json'));
  assert.deepEqual(events, [
    { type: 'registry-change', name: 'keeper', severity: 'high', from: 'registry.npmjs.org', to: null },
  ]);
  assert.equal(diffExitCode(events), 0);
});

test('resolved URL removed entirely: registry-change from host to null', () => {
  const oldLock = normalizeLockfile({
    name: 'a', lockfileVersion: 3,
    packages: {
      '': { name: 'a', dependencies: { keeper: '^1.0.0' } },
      'node_modules/keeper': { version: '1.0.0', resolved: 'https://registry.npmjs.org/keeper/-/keeper-1.0.0.tgz' },
    },
  });
  const newLock = normalizeLockfile({
    name: 'a', lockfileVersion: 3,
    packages: {
      '': { name: 'a', dependencies: { keeper: '^1.0.0' } },
      'node_modules/keeper': { version: '1.0.0' },
    },
  });
  const events = diffRecords(oldLock, newLock);
  assert.deepEqual(events, [
    { type: 'registry-change', name: 'keeper', severity: 'high', from: 'registry.npmjs.org', to: null },
  ]);
});

test('both sides without any resolved origin: no registry event', () => {
  const both = normalizeLockfile({
    name: 'a', lockfileVersion: 3,
    packages: {
      '': { name: 'a', dependencies: { keeper: '^1.0.0' } },
      'node_modules/keeper': { version: '1.0.0' },
    },
  });
  assert.deepEqual(diffRecords(both, both), []);
});

test('identical lockfiles: no events', () => {
  assert.deepEqual(diffRecords(load('diff-base.json'), load('diff-base.json')), []);
});

test('v1-style unknown flags count as script-capable additions (conservative)', () => {
  const oldLock = normalizeLockfile({ name: 'a', lockfileVersion: 1, dependencies: { keeper: { version: '1.0.0' } } });
  const newLock = normalizeLockfile({ name: 'a', lockfileVersion: 1, dependencies: { keeper: { version: '1.0.0' }, newcomer: { version: '2.0.0' } } });
  const events = diffRecords(oldLock, newLock);
  assert.deepEqual(events, [
    { type: 'added-script-package', name: 'newcomer', severity: 'high', from: null, to: '2.0.0' },
  ]);
});
