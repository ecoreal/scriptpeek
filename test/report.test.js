// test/report.test.js — stable --json schema snapshots + human table content,
// driven through runCli with buffered output (no spawn, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';

const fx = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const withV3 = ['--lockfile', fx('lock-v3.json')];

function bufIo() {
  const outBuf = [];
  const errBuf = [];
  return {
    io: { out: (s) => outBuf.push(s), err: (s) => errBuf.push(s) },
    out: () => outBuf.join('\n'),
    err: () => errBuf.join('\n'),
  };
}

test('scan --json: top-level, summary and per-package key sets are stable', async () => {
  const b = bufIo();
  const code = await runCli(['scan', '--json', ...withV3], b.io);
  assert.equal(code, 0);
  const doc = JSON.parse(b.out());
  assert.deepEqual(Object.keys(doc).sort(), ['command', 'lockfile', 'lockfileVersion', 'packages', 'projectName', 'summary', 'tool', 'version']);
  assert.deepEqual(Object.keys(doc.summary).sort(), ['listedPackages', 'scriptPackages', 'totalPackages', 'unknownScriptPackages']);
  for (const p of doc.packages) {
    assert.deepEqual(Object.keys(p).sort(), ['dependencyPaths', 'hasInstallScript', 'host', 'key', 'name', 'pathsTruncated', 'resolved', 'version']);
  }
  assert.equal(doc.command, 'scan');
  assert.equal(doc.tool, 'scriptpeek');
  assert.equal(doc.version, '0.1.0');
});

test('scan table shows package@version, script flag, registry host and dependency path', async () => {
  const b = bufIo();
  const code = await runCli(['scan', ...withV3], b.io);
  assert.equal(code, 0);
  const out = b.out();
  for (const needle of [
    'Package', 'Scripts', 'Registry', 'Dependency path',
    'toolkit@2.0.0', 'devonly@1.0.0', 'postcorg@1.5.0',
    'registry.npmjs.org',
    'fixture-app > toolkit', 'fixture-app > beta > postcorg',
  ]) {
    assert.ok(out.includes(needle), `missing in table: ${needle}`);
  }
});

test('v1 scan lists everything as unknown, in JSON and in the human note', async () => {
  const b = bufIo();
  const code = await runCli(['scan', '--json', '--lockfile', fx('lock-v1.json')], b.io);
  assert.equal(code, 0);
  const doc = JSON.parse(b.out());
  assert.equal(doc.summary.unknownScriptPackages, 4);
  assert.equal(doc.summary.scriptPackages, 0);
  assert.ok(doc.packages.every((p) => p.hasInstallScript === null));
  const h = bufIo();
  await runCli(['scan', '--lockfile', fx('lock-v1.json')], h.io);
  assert.ok(h.out().includes('unknown'));
});

test('scripts --json: key sets are stable even when every result is degraded', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'scriptpeek-report-'));
  const b = bufIo();
  const code = await runCli(['scripts', '--json', '--offline', '--cache-dir', cache, ...withV3], b.io);
  assert.equal(code, 0);
  const doc = JSON.parse(b.out());
  assert.deepEqual(Object.keys(doc).sort(), ['command', 'lockfile', 'offline', 'registry', 'results', 'summary', 'tool', 'version']);
  assert.deepEqual(Object.keys(doc.summary).sort(), ['cached', 'fetched', 'total', 'unavailable']);
  for (const r of doc.results) {
    assert.deepEqual(Object.keys(r).sort(), ['hasInstallScript', 'host', 'key', 'name', 'note', 'scripts', 'source', 'version']);
  }
  assert.ok(doc.results.every((r) => r.source === 'unavailable' && r.scripts === null && r.note.includes('no script text available')));
});

test('diff --json: top-level, summary and event key sets are stable', async () => {
  const b = bufIo();
  const code = await runCli(['diff', '--json', fx('diff-base.json'), fx('diff-new-added-script.json')], b.io);
  assert.equal(code, 1);
  const doc = JSON.parse(b.out());
  assert.deepEqual(Object.keys(doc).sort(), ['command', 'events', 'exitCode', 'new', 'noFail', 'old', 'summary', 'tool', 'version']);
  assert.deepEqual(Object.keys(doc.summary).sort(), ['addedScriptPackages', 'registryChanges', 'versionChanges']);
  for (const ev of doc.events) {
    assert.deepEqual(Object.keys(ev).sort(), ['from', 'name', 'severity', 'to', 'type']);
  }
  assert.equal(doc.summary.addedScriptPackages, 1);
  assert.equal(doc.exitCode, 1);
});

test('explain --json: key sets are stable; multi-version package lists all paths', async () => {
  const b = bufIo();
  const code = await runCli(['explain', '--json', 'shared', ...withV3], b.io);
  assert.equal(code, 0);
  const doc = JSON.parse(b.out());
  assert.deepEqual(Object.keys(doc).sort(), ['command', 'found', 'isScriptPackage', 'lockfile', 'matches', 'package', 'tool', 'version']);
  for (const m of doc.matches) {
    assert.deepEqual(Object.keys(m).sort(), ['hasInstallScript', 'host', 'key', 'name', 'paths', 'pathsTruncated', 'resolved', 'version']);
  }
  assert.equal(doc.matches.length, 2);
  const all = doc.matches.flatMap((m) => m.paths).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  assert.deepEqual(all, [['fixture-app', 'alpha', 'shared'], ['fixture-app', 'beta', 'shared'], ['fixture-app', 'toolkit', 'shared']]);
});

test('human diff and explain render event lines and path arrows', async () => {
  const b = bufIo();
  await runCli(['diff', fx('diff-base.json'), fx('diff-new-registry-change.json')], b.io);
  assert.ok(b.out().includes('registry-change'));
  assert.ok(b.out().includes('registry.npmjs.org -> evil.example.com'));
  assert.ok(b.out().includes('exit: 0'));

  const c = bufIo();
  await runCli(['explain', 'toolkit', ...withV3], c.io);
  assert.ok(c.out().includes('toolkit@2.0.0'));
  assert.ok(c.out().includes('fixture-app > toolkit'));
  assert.ok(c.out().includes('install script: yes'));

  const d = bufIo();
  const code = await runCli(['explain', 'ghost', ...withV3], d.io);
  assert.equal(code, 1);
  assert.ok(d.out().includes('package not found in lockfile: ghost'));
});
