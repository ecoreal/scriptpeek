// test/graph.test.js — diamond paths, root-direct deps, cycles, isolated nodes,
// nearest-node_modules resolution, and the per-target path cap. Graphs are
// synthetic (no fixture files needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, allPaths, pathNames, MAX_PATHS_PER_TARGET } from '../src/graph.js';

function makeLock(records, rootDeps, projectName = 'app') {
  const nodes = new Map(records.map((r) => [r.key, r]));
  return { projectName, nodes, rootDependencies: rootDeps, records };
}
const rec = (key, name, deps = {}) => ({ key, name, version: '1.0.0', resolved: null, host: null, hasInstallScript: false, dependencies: deps });

function pathsFor(lock, targetKey, opts = {}) {
  const g = buildGraph(lock);
  const { paths, truncated } = allPaths(g, targetKey, opts);
  return { names: paths.map((p) => pathNames(g, p, lock.projectName)), truncated };
}

test('diamond dependency: every path from root is listed', () => {
  const lock = makeLock([
    rec('node_modules/a', 'a', { d: '*' }),
    rec('node_modules/b', 'b', { d: '*' }),
    rec('node_modules/d', 'd'),
  ], { a: '*', b: '*' });
  const { names } = pathsFor(lock, 'node_modules/d');
  assert.deepEqual(names.sort(), [['app', 'a', 'd'], ['app', 'b', 'd']]);
});

test('root direct dependency: single two-element path', () => {
  const lock = makeLock([rec('node_modules/x', 'x')], { x: '*' });
  assert.deepEqual(pathsFor(lock, 'node_modules/x').names, [['app', 'x']]);
});

test('isolated package: unreachable from root yields no paths', () => {
  const lock = makeLock([rec('node_modules/lonely', 'lonely')], {});
  assert.deepEqual(pathsFor(lock, 'node_modules/lonely').names, []);
});

test('dependency cycle: finite output, no node repeats inside one path', () => {
  const lock = makeLock([
    rec('node_modules/a', 'a', { b: '*' }),
    rec('node_modules/b', 'b', { c: '*' }),
    rec('node_modules/c', 'c', { a: '*', d: '*' }),
    rec('node_modules/d', 'd'),
  ], { a: '*' });
  // completes (no infinite loop) and yields exactly the one simple path
  const { names } = pathsFor(lock, 'node_modules/d');
  assert.deepEqual(names, [['app', 'a', 'b', 'c', 'd']]);
  // target sitting on the cycle itself still terminates
  const toA = pathsFor(lock, 'node_modules/a').names;
  assert.deepEqual(toA, [['app', 'a']]);
  for (const p of [...names, ...toA]) assert.equal(new Set(p).size, p.length);
});

test('nested resolution: a dep binds to the nearest node_modules entry', () => {
  const lock = makeLock([
    rec('node_modules/a', 'a', { s: '*' }),
    rec('node_modules/b', 'b', { s: '*' }),
    rec('node_modules/s', 's'),
    rec('node_modules/a/node_modules/s', 's'),
  ], { a: '*', b: '*' });
  // a's dep resolves to its private nested copy; the hoisted one only via b
  assert.deepEqual(pathsFor(lock, 'node_modules/s').names, [['app', 'b', 's']]);
  assert.deepEqual(pathsFor(lock, 'node_modules/a/node_modules/s').names, [['app', 'a', 's']]);
});

test('declared dep with no installed entry yields no edge', () => {
  const lock = makeLock([rec('node_modules/a', 'a', { ghost: '*' })], { a: '*' });
  const g = buildGraph(lock);
  assert.deepEqual(g.edges.get('node_modules/a'), []);
});

// width nodes per layer, each node in layer i depending on every node of layer i+1
function layered(width, layers) {
  const records = [];
  const name = (i, j) => `l${i}n${j}`;
  for (let i = 0; i < layers; i++) {
    for (let j = 0; j < width; j++) {
      const deps = {};
      if (i + 1 < layers) for (let k = 0; k < width; k++) deps[name(i + 1, k)] = '*';
      records.push(rec(`node_modules/${name(i, j)}`, name(i, j), deps));
    }
  }
  const rootDeps = {};
  for (let j = 0; j < width; j++) rootDeps[name(0, j)] = '*';
  return makeLock(records, rootDeps);
}

test('no truncation below the cap', () => {
  const lock = layered(3, 4); // 3^3 = 27 simple paths to the last layer
  const { names, truncated } = pathsFor(lock, 'node_modules/l3n0');
  assert.equal(names.length, 27);
  assert.equal(truncated, false);
});

test('path cap: enumeration stops at MAX_PATHS_PER_TARGET with truncated flag', () => {
  const lock = layered(2, 11); // 2^10 = 1024 simple paths to the last layer
  const { names, truncated } = pathsFor(lock, 'node_modules/l10n0');
  assert.equal(truncated, true);
  assert.equal(names.length, MAX_PATHS_PER_TARGET);
});

test('reviewer-scale dense graph (8 wide x 7 deep, 262,144 potential paths) is capped, not unbounded', () => {
  const lock = layered(8, 7); // 8^6 = 262,144 paths to the last layer
  const started = process.hrtime.bigint();
  const { names, truncated } = pathsFor(lock, 'node_modules/l6n0');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(truncated, true);
  assert.equal(names.length, MAX_PATHS_PER_TARGET);
  assert.ok(ms < 2000, `early-exit cap should bound the work; took ${ms.toFixed(0)}ms`);
});

test('limit option: callers can cap lower than the default', () => {
  const lock = makeLock([
    rec('node_modules/a', 'a', { d: '*' }),
    rec('node_modules/b', 'b', { d: '*' }),
    rec('node_modules/d', 'd'),
  ], { a: '*', b: '*' });
  const one = pathsFor(lock, 'node_modules/d', { limit: 1 });
  assert.equal(one.names.length, 1);
  assert.equal(one.truncated, true);
  const all = pathsFor(lock, 'node_modules/d', { limit: 10 });
  assert.equal(all.names.length, 2);
  assert.equal(all.truncated, false);
});
