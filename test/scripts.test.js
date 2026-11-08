// test/scripts.test.js — script text extraction, disk cache hits, offline
// degradation, injected-fetch failures. Registry is a local node:http mock on
// 127.0.0.1 (ephemeral port): fully offline, request-counted.
// Note: no shared helper module — `node --test` executes every .js under test/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchScriptInfo, extractScripts, packumentUrl } from '../src/scripts.js';

const fxJson = (f) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)), 'utf8'));
const tmpCache = () => mkdtempSync(path.join(tmpdir(), 'scriptpeek-scripts-'));

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
      hitsFor: (urlPath) => state.urls.filter((u) => u === urlPath).length,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const rec = (name, version, extra = {}) => ({
  key: extra.key ?? `node_modules/${name}`,
  name,
  version,
  resolved: extra.resolved ?? null,
  host: extra.host ?? null,
  hasInstallScript: extra.hasInstallScript ?? true,
  dependencies: {},
});

test('extractScripts pulls exactly the four lifecycle fields', () => {
  const doc = { versions: { '1.0.0': { scripts: { preinstall: 'a', install: 'b', postinstall: 'c', prepack: 'd', test: 'nope', prepare: 'nope' } } } };
  assert.deepEqual(extractScripts(doc, '1.0.0'), { preinstall: 'a', install: 'b', postinstall: 'c', prepack: 'd' });
  assert.deepEqual(extractScripts({ versions: { '1.0.0': {} } }, '1.0.0'), {});
  assert.equal(extractScripts(doc, '9.9.9'), null);
  assert.equal(extractScripts(null, '1.0.0'), null);
});

test('packumentUrl encodes scoped names and strips trailing slashes', () => {
  assert.equal(packumentUrl('https://r.example.com/', 'pkga'), 'https://r.example.com/pkga');
  assert.equal(packumentUrl('https://r.example.com', '@scope/pkgb'), 'https://r.example.com/@scope%2Fpkgb');
});

test('fetch + disk cache: script text extracted, second run is cache-only (zero extra requests)', async () => {
  const reg = await startRegistry({
    peekme: fxJson('packument-peekme.json'),
    calmone: fxJson('packument-calmone.json'),
    '@peek/boxed': fxJson('packument-scoped.json'),
  });
  try {
    const cache = tmpCache();
    const records = [
      rec('peekme', '1.0.0', { resolved: `${reg.origin}/peekme/-/peekme-1.0.0.tgz`, host: new URL(reg.origin).host }),
      rec('calmone', '1.0.0', { resolved: `${reg.origin}/calmone/-/calmone-1.0.0.tgz`, host: new URL(reg.origin).host }),
      rec('@peek/boxed', '1.0.0', { resolved: `${reg.origin}/@peek/boxed/-/boxed-1.0.0.tgz`, host: new URL(reg.origin).host }),
    ];
    const first = await fetchScriptInfo(records, { cacheDir: cache });
    assert.equal(reg.hits(), 3);
    assert.deepEqual(first.map((r) => r.source), ['registry', 'registry', 'registry']);
    assert.deepEqual(first[0].scripts, { preinstall: 'echo preinstall-peekme', install: 'node-gyp rebuild', postinstall: 'echo postinstall-peekme', prepack: 'echo prepack-peekme' });
    assert.deepEqual(first[1].scripts, {});
    assert.deepEqual(first[2].scripts, { install: 'echo boxed-install' });
    for (const r of first) {
      assert.deepEqual(Object.keys(r).sort(), ['hasInstallScript', 'host', 'key', 'name', 'note', 'scripts', 'source', 'version']);
    }

    const second = await fetchScriptInfo(records, { cacheDir: cache });
    assert.equal(reg.hits(), 3); // cache hit → no second request hit the server
    assert.deepEqual(second.map((r) => r.source), ['cache', 'cache', 'cache']);
    assert.deepEqual(second[0].scripts, first[0].scripts);
  } finally {
    await reg.close();
  }
});

test('hasInstallScript=false records are skipped entirely', async () => {
  const reg = await startRegistry({});
  try {
    const out = await fetchScriptInfo(
      [rec('nope', '1.0.0', { hasInstallScript: false, resolved: `${reg.origin}/nope/-/nope-1.0.0.tgz` })],
      { cacheDir: tmpCache() },
    );
    assert.deepEqual(out, []);
    assert.equal(reg.hits(), 0);
  } finally {
    await reg.close();
  }
});

test('--offline with cold cache degrades without touching the network', async () => {
  const reg = await startRegistry({ peekme: fxJson('packument-peekme.json') });
  try {
    const out = await fetchScriptInfo(
      [rec('peekme', '1.0.0', { resolved: `${reg.origin}/peekme/-/peekme-1.0.0.tgz` })],
      { cacheDir: tmpCache(), offline: true },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'unavailable');
    assert.equal(out[0].scripts, null);
    assert.ok(out[0].note.includes('no script text available'));
    assert.equal(reg.hits(), 0);
  } finally {
    await reg.close();
  }
});

test('--offline uses a warm cache without any request', async () => {
  const reg = await startRegistry({ peekme: fxJson('packument-peekme.json') });
  try {
    const cache = tmpCache();
    const target = [rec('peekme', '1.0.0', { resolved: `${reg.origin}/peekme/-/peekme-1.0.0.tgz` })];
    await fetchScriptInfo(target, { cacheDir: cache });
    const hits = reg.hits();
    const out = await fetchScriptInfo(target, { cacheDir: cache, offline: true });
    assert.equal(out[0].source, 'cache');
    assert.deepEqual(out[0].scripts.install, 'node-gyp rebuild');
    assert.equal(reg.hits(), hits);
  } finally {
    await reg.close();
  }
});

test('injected fetch failure degrades per package instead of throwing', async () => {
  const out = await fetchScriptInfo(
    [rec('boom', '1.0.0', { resolved: 'https://registry.npmjs.org/boom/-/boom-1.0.0.tgz', host: 'registry.npmjs.org' })],
    { cacheDir: tmpCache(), fetchImpl: async () => { throw new Error('boom'); } },
  );
  assert.equal(out[0].source, 'unavailable');
  assert.equal(out[0].scripts, null);
  assert.ok(out[0].note.includes('registry fetch failed'));
  assert.ok(out[0].note.includes('boom'));
});

test('HTTP error status degrades with the status code in the note', async () => {
  const out = await fetchScriptInfo(
    [rec('gone', '1.0.0', { resolved: 'https://registry.npmjs.org/gone/-/gone-1.0.0.tgz', host: 'registry.npmjs.org' })],
    { cacheDir: tmpCache(), fetchImpl: async () => ({ ok: false, status: 503 }) },
  );
  assert.equal(out[0].source, 'unavailable');
  assert.ok(out[0].note.includes('503'));
});

test('version missing from packument degrades with a precise note', async () => {
  const reg = await startRegistry({ peekme: fxJson('packument-peekme.json') });
  try {
    const out = await fetchScriptInfo(
      [rec('peekme', '9.9.9', { resolved: `${reg.origin}/peekme/-/peekme-9.9.9.tgz` })],
      { cacheDir: tmpCache() },
    );
    assert.equal(out[0].source, 'unavailable');
    assert.ok(out[0].note.includes('version 9.9.9 not found in registry packument'));
  } finally {
    await reg.close();
  }
});

test('--registry overrides the resolved origin', async () => {
  const reg = await startRegistry({ peekme: fxJson('packument-peekme.json') });
  try {
    const out = await fetchScriptInfo(
      [rec('peekme', '1.0.0', { resolved: 'https://registry.npmjs.org/peekme/-/peekme-1.0.0.tgz', host: 'registry.npmjs.org' })],
      { cacheDir: tmpCache(), registry: reg.origin },
    );
    assert.equal(out[0].source, 'registry');
    assert.equal(out[0].scripts.install, 'node-gyp rebuild');
    assert.equal(reg.hits(), 1);
  } finally {
    await reg.close();
  }
});

test('no resolved URL and no override: degrade without any request', async () => {
  let called = 0;
  const out = await fetchScriptInfo(
    [rec('localpkg', '1.0.0')],
    { cacheDir: tmpCache(), fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({}) }; } },
  );
  assert.equal(called, 0);
  assert.equal(out[0].source, 'unavailable');
  assert.ok(out[0].note.includes('no resolved URL'));
});
