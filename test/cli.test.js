// test/cli.test.js — end-to-end contract via spawned `node bin/scriptpeek.js`:
// help/version exit codes, per-command --help, exit-code normalization, --json
// parseability, and a scripts run against a local node:http mock registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/scriptpeek.js', import.meta.url));
const fx = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const tmp = () => mkdtempSync(path.join(tmpdir(), 'scriptpeek-cli-'));
const fxJson = (f) => JSON.parse(readFileSync(fx(f), 'utf8'));

function run(args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

// Async spawn: unlike spawnSync, it keeps this process's event loop free so the
// in-process mock registry can answer requests while the child is running.
function runAsync(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

// Local mock registry (same shape as scripts.test.js; kept inline because
// `node --test` executes every .js file under test/, so no shared helper).
function startRegistry(packuments) {
  const state = { hits: 0, urls: [] };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    state.urls.push(req.url);
    const name = decodeURIComponent(req.url.replace(/^\/+/, ''));
    const doc = packuments[name];
    if (!doc) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(doc));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      hits: () => state.hits,
      hitsFor: (p) => state.urls.filter((u) => u === p).length,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('--help and -h exit 0 with usage keywords', () => {
  for (const flag of ['--help', '-h']) {
    const r = run([flag], tmp());
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('Usage:'));
    assert.ok(r.stdout.includes('scriptpeek'));
    assert.ok(r.stdout.includes('scan'));
  }
});

test('--version exits 0 and prints a semver', () => {
  const r = run(['--version'], tmp());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('no arguments: usage error, exit 1', () => {
  const r = run([], tmp());
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('Usage:'));
});

test('unknown subcommand: exit 1 with a plain message', () => {
  const r = run(['frobnicate'], tmp());
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('unknown command "frobnicate"'));
});

test('every subcommand answers --help with exit 0', () => {
  for (const cmd of ['scan', 'scripts', 'diff', 'explain']) {
    const r = run([cmd, '--help'], tmp());
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
    assert.ok(r.stdout.includes('Usage: scriptpeek ' + cmd), `${cmd} help header`);
  }
});

test('scan --json lists script packages with fields and dependency paths', () => {
  const r = run(['scan', '--json', '--lockfile', fx('lock-v3.json')], tmp());
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  // unknown-for-missing-flag: every entry without the flag is listed as unknown
  assert.equal(doc.packages.length, 7);
  assert.deepEqual(doc.packages.map((p) => `${p.name}@${p.key}`), [
    'alpha@node_modules/alpha',
    'beta@node_modules/beta',
    'devonly@node_modules/devonly',
    'postcorg@node_modules/beta/node_modules/postcorg',
    'shared@node_modules/alpha/node_modules/shared',
    'shared@node_modules/shared',
    'toolkit@node_modules/toolkit',
  ]);
  const postcorg = doc.packages.find((p) => p.name === 'postcorg');
  assert.equal(postcorg.hasInstallScript, true);
  assert.equal(postcorg.host, 'registry.npmjs.org');
  assert.deepEqual(postcorg.dependencyPaths, [['fixture-app', 'beta', 'postcorg']]);
  assert.equal(postcorg.pathsTruncated, false);
  const alpha = doc.packages.find((p) => p.name === 'alpha');
  assert.equal(alpha.hasInstallScript, null); // npm/cli#2606: missing flag is unknown
  assert.deepEqual(doc.summary, { totalPackages: 7, listedPackages: 7, scriptPackages: 3, unknownScriptPackages: 4 });
});

test('regression (npm/cli#2606): a v2 lockfile without recorded flags lists them as unknown', () => {
  const r = run(['scan', '--json', '--lockfile', fx('lock-v2.json')], tmp());
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  const alpha = doc.packages.find((p) => p.name === 'alpha');
  assert.ok(alpha, 'flag-less alpha must be listed, not silently skipped');
  assert.equal(alpha.hasInstallScript, null);
  assert.equal(doc.summary.unknownScriptPackages >= 4, true);
});

test('scan human output renders the table', () => {
  const r = run(['scan', '--lockfile', fx('lock-v3.json')], tmp());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('Package'));
  assert.ok(r.stdout.includes('toolkit@2.0.0'));
});

test('scan error cases exit 2 with human-readable messages', () => {
  const missing = run(['scan'], tmp()); // cwd has no package-lock.json
  assert.equal(missing.status, 2);
  assert.ok(missing.stderr.includes('cannot read lockfile'));

  const invalid = run(['scan', '--lockfile', fx('lock-invalid.json')], tmp());
  assert.equal(invalid.status, 2);
  assert.ok(invalid.stderr.includes('not valid JSON'));

  const unknownV = run(['scan', '--lockfile', fx('lock-unknown.json')], tmp());
  assert.equal(unknownV.status, 2);
  assert.ok(unknownV.stderr.includes('unsupported lockfileVersion'));
});

test('diff exit codes: 1 on added script package, 0 otherwise, --no-fail forces 0', () => {
  const t = tmp();
  assert.equal(run(['diff', fx('diff-base.json'), fx('diff-new-added-script.json')], t).status, 1);
  assert.equal(run(['diff', '--no-fail', fx('diff-base.json'), fx('diff-new-added-script.json')], t).status, 0);
  assert.equal(run(['diff', fx('diff-base.json'), fx('diff-new-added-plain.json')], t).status, 0);

  const vc = run(['diff', fx('diff-base.json'), fx('diff-new-version-change.json')], t);
  assert.equal(vc.status, 0);
  assert.ok(vc.stdout.includes('version-change'));

  const rc = run(['diff', fx('diff-base.json'), fx('diff-new-registry-change.json')], t);
  assert.equal(rc.status, 0);
  assert.ok(rc.stdout.includes('registry-change'));

  // origin repointed to a file:/local tarball (host becomes null) must not be silent
  const fo = run(['diff', fx('diff-base.json'), fx('diff-new-origin-removed.json')], t);
  assert.equal(fo.status, 0);
  assert.ok(fo.stdout.includes('registry-change'));
  assert.ok(fo.stdout.includes('(none)'));
});

test('diff --json is parseable and carries events plus exitCode', () => {
  const r = run(['diff', '--json', fx('diff-base.json'), fx('diff-new-added-script.json')], tmp());
  assert.equal(r.status, 1);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.command, 'diff');
  assert.equal(doc.summary.addedScriptPackages, 1);
  assert.equal(doc.exitCode, 1);
  assert.equal(doc.events[0].type, 'added-script-package');
});

test('diff usage and input errors', () => {
  const t = tmp();
  const noArgs = run(['diff'], t);
  assert.equal(noArgs.status, 1);
  assert.ok(noArgs.stderr.includes('missing <old-lockfile>'));
  assert.equal(run(['diff', fx('definitely-not-here.json'), fx('diff-base.json')], t).status, 2);
});

test('explain: found package exits 0 with paths, missing package exits 1', () => {
  const found = run(['explain', 'toolkit', '--json', '--lockfile', fx('lock-v3.json')], tmp());
  assert.equal(found.status, 0, found.stderr);
  const doc = JSON.parse(found.stdout);
  assert.equal(doc.found, true);
  assert.equal(doc.isScriptPackage, true);
  assert.deepEqual(doc.matches[0].paths, [['fixture-app', 'toolkit']]);

  assert.equal(run(['explain', 'ghost-pkg', '--lockfile', fx('lock-v3.json')], tmp()).status, 1);
  const noArg = run(['explain'], tmp());
  assert.equal(noArg.status, 1);
  assert.ok(noArg.stderr.includes('missing <package>'));

  // --json of the not-found case is still parseable
  const nf = run(['explain', 'ghost-pkg', '--json', '--lockfile', fx('lock-v3.json')], tmp());
  assert.equal(nf.status, 1);
  assert.equal(JSON.parse(nf.stdout).found, false);
});

test('scripts end-to-end: fetch, disk cache hit, offline degrade', async () => {
  const reg = await startRegistry({
    peekme: fxJson('packument-peekme.json'),
    calmone: fxJson('packument-calmone.json'),
    '@peek/boxed': fxJson('packument-scoped.json'),
  });
  try {
    const cache = tmp();
    const base = ['scripts', '--json', '--registry', reg.origin, '--cache-dir', cache, '--lockfile', fx('lock-scripts.json')];

    const r1 = await runAsync(base, tmp());
    assert.equal(r1.status, 0, r1.stderr);
    const d1 = JSON.parse(r1.stdout);
    assert.equal(d1.summary.total, 4);
    const peekme = d1.results.find((r) => r.name === 'peekme');
    assert.equal(peekme.source, 'registry');
    assert.deepEqual(peekme.scripts, {
      preinstall: 'echo preinstall-peekme',
      install: 'node-gyp rebuild',
      postinstall: 'echo postinstall-peekme',
      prepack: 'echo prepack-peekme',
    });
    assert.equal(d1.results.find((r) => r.name === 'noorigin').source, 'unavailable');
    assert.equal(reg.hitsFor('/peekme'), 1);

    const r2 = await runAsync(base, tmp());
    assert.equal(r2.status, 0, r2.stderr);
    const d2 = JSON.parse(r2.stdout);
    assert.equal(d2.summary.cached, 3); // peekme, calmone, @peek/boxed served from cache
    assert.equal(reg.hitsFor('/peekme'), 1); // cache hit → zero extra requests
    assert.equal(reg.hitsFor('/noorigin'), 2); // failed 404 is not cached → retried

    const hitsBefore = reg.hits();
    const r3 = await runAsync(['scripts', '--json', '--offline', '--cache-dir', tmp(), '--lockfile', fx('lock-scripts.json')], tmp());
    assert.equal(r3.status, 0, r3.stderr);
    const d3 = JSON.parse(r3.stdout);
    assert.ok(d3.results.every((r) => r.source === 'unavailable' && r.scripts === null));
    assert.ok(d3.results.every((r) => r.note.includes('no script text available')));
    assert.equal(reg.hits(), hitsBefore); // --offline never touches the network
  } finally {
    await reg.close();
  }
});
