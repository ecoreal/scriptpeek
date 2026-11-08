// src/lockfile.js — read package-lock.json (lockfileVersion 1/2/3) and normalize it
// into a record set of installed packages plus classified errors.
// Zero dependencies: Node.js standard library only.
import { readFileSync } from 'node:fs';

export class LockfileError extends Error {
  // kind: 'missing' | 'invalid' | 'unknown-version'
  constructor(kind, message, filePath) {
    super(message);
    this.name = 'LockfileError';
    this.kind = kind;
    this.filePath = filePath;
  }
}

export function loadLockfile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new LockfileError('missing', `cannot read lockfile: ${filePath} (${err?.code ?? err?.message ?? err})`, filePath);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new LockfileError('invalid', `lockfile is not valid JSON: ${filePath} (${err?.message ?? err})`, filePath);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new LockfileError('invalid', `lockfile is not a JSON object: ${filePath}`, filePath);
  }
  const lv = data.lockfileVersion;
  if (lv !== 1 && lv !== 2 && lv !== 3) {
    // Also covers lockfiles with no lockfileVersion at all (e.g. a stray package.json).
    throw new LockfileError('unknown-version', `unsupported lockfileVersion ${JSON.stringify(lv ?? null)} in ${filePath} (expected 1, 2 or 3)`, filePath);
  }
  return normalizeLockfile(data, filePath);
}

// Normalize an already-parsed lockfile object into:
//   records — sorted array of { key, name, version, resolved, host, hasInstallScript, dependencies }
//   rootDependencies — declared direct deps of the project (prod + dev; both get installed by npm ci)
//   nodes — Map<key, record> used by graph.js
// hasInstallScript: true/false when the lockfile records it (v2/v3 `packages`),
// null when unknowable (v1 nested tree has no such flag — treat as "candidate").
export function normalizeLockfile(data, sourcePath = '<memory>') {
  const lockfileVersion = data.lockfileVersion;
  const nodes = new Map();
  const useV1Tree = lockfileVersion === 1 || (lockfileVersion === 2 && !isPlainObject(data.packages));
  const rootDependencies = useV1Tree ? collectV1(data, nodes) : collectV2or3(data, nodes);
  const records = [...nodes.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    sourcePath,
    lockfileVersion,
    projectName: typeof data.name === 'string' ? data.name : null,
    projectVersion: typeof data.version === 'string' ? data.version : null,
    rootDependencies,
    nodes,
    records,
  };
}

function collectV2or3(data, nodes) {
  const rootDeps = {};
  const packages = isPlainObject(data.packages) ? data.packages : {};
  const rootEntry = packages[''];
  if (isPlainObject(rootEntry)) Object.assign(rootDeps, rootEntry.dependencies ?? {}, rootEntry.devDependencies ?? {});
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '' || !isPlainObject(entry)) continue;
    const name = nameFromKey(key);
    if (!name) continue; // workspace/link paths outside node_modules are out of scope for v0.1
    if (entry.link === true) continue;
    if (typeof entry.version !== 'string' && typeof entry.resolved !== 'string') continue;
    nodes.set(key, makeRecord(key, name, entry.version ?? null, entry.resolved ?? null, installScriptFlag(entry), entry.dependencies ?? {}));
  }
  return rootDeps;
}

function collectV1(data, nodes) {
  const rootDeps = {};
  const top = isPlainObject(data.dependencies) ? data.dependencies : {};
  for (const name of Object.keys(top)) rootDeps[name] = ''; // v1 root deps are just the top-level tree keys
  walkV1(top, '', nodes);
  return rootDeps;
}

function walkV1(tree, prefix, nodes) {
  for (const [name, entry] of Object.entries(tree)) {
    if (!isPlainObject(entry)) continue;
    const key = `${prefix}node_modules/${name}`;
    // `requires` holds the declared spec map; fall back to nested dependency names.
    const declared = isPlainObject(entry.requires) ? { ...entry.requires } : objectKeys(entry.dependencies);
    nodes.set(key, makeRecord(key, name, entry.version ?? null, entry.resolved ?? null, null, declared));
    if (isPlainObject(entry.dependencies)) walkV1(entry.dependencies, `${key}/`, nodes);
  }
}

// "node_modules/a/node_modules/b" -> "b"; "node_modules/@scope/pkg" -> "@scope/pkg".
function nameFromKey(key) {
  const idx = key.lastIndexOf('/node_modules/');
  if (idx !== -1) return key.slice(idx + '/node_modules/'.length);
  if (key.startsWith('node_modules/')) return key.slice('node_modules/'.length);
  return null;
}

// npm only ever writes `hasInstallScript: true` (arborist's lockfile writer skips
// falsy fields), and npm/cli#2606 loses the flag entirely on some lockfiles
// (notably v1->v2 upgrades, npm 7 through 9.x: esbuild/electron class packages).
// So a missing field must NOT read as "false": it is unknown, and unknown
// packages stay in the conservative candidate set instead of being skipped.
// Only an explicit false is authoritative.
function installScriptFlag(entry) {
  if (entry.hasInstallScript === true) return true;
  if (entry.hasInstallScript === false) return false;
  return null;
}

function makeRecord(key, name, version, resolved, hasInstallScript, dependencies) {
  return { key, name, version, resolved, host: hostOf(resolved), hasInstallScript, dependencies };
}

function hostOf(resolved) {
  if (typeof resolved !== 'string' || resolved === '') return null;
  try {
    return new URL(resolved).host || null;
  } catch {
    return null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function objectKeys(o) {
  return isPlainObject(o) ? Object.fromEntries(Object.keys(o).map((k) => [k, ''])) : {};
}
