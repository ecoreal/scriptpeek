// src/scripts.js — registry packument fetching with injectable fetch (for mocks),
// lifecycle script extraction, disk cache, and --offline degradation.
// Zero dependencies: Node.js standard library only.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const SCRIPT_KEYS = ['preinstall', 'install', 'postinstall', 'prepack'];
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

function stripTrailingSlash(s) {
  return s.replace(/\/+$/, '');
}

// Default registry host follows the lockfile's resolved origin per package;
// an explicit --registry override wins over everything.
export function registryBase(record, override) {
  if (override) return stripTrailingSlash(override);
  if (record.resolved) return new URL(record.resolved).origin; // may throw on garbage; callers catch
  return DEFAULT_REGISTRY;
}

// Scoped names go as @scope%2Fname (npm registry convention); the leading @ stays.
export function packumentUrl(base, name) {
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : encodeURIComponent(name);
  return `${stripTrailingSlash(base)}/${encoded}`;
}

// Pull exactly the four lifecycle fields we audit; empty object when the
// version exists but declares none; null when the version is not in the packument.
export function extractScripts(packument, version) {
  const v = packument && packument.versions ? packument.versions[version] : undefined;
  if (!v) return null;
  const s = v.scripts ?? {};
  const out = {};
  for (const k of SCRIPT_KEYS) {
    if (typeof s[k] === 'string' && s[k].trim() !== '') out[k] = s[k];
  }
  return out;
}

// Readable + collision-proof cache file name: sanitized id plus a short digest.
function cacheFileName(name, version) {
  const id = `${name}@${version}`;
  const safe = id.replace(/[^A-Za-z0-9@._-]/g, '_');
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 12);
  return `${safe}-${digest}.json`;
}

export async function readCachedScripts(cacheDir, name, version) {
  let raw;
  try {
    raw = await readFile(path.join(cacheDir, cacheFileName(name, version)), 'utf8');
  } catch {
    return null; // miss / unreadable
  }
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null; // corrupt cache counts as a miss
  }
  if (!entry || entry.name !== name || entry.version !== version) return null;
  return entry.scripts && typeof entry.scripts === 'object' ? entry.scripts : null;
}

export async function writeCachedScripts(cacheDir, name, version, scripts, url) {
  await mkdir(cacheDir, { recursive: true });
  const entry = { tool: 'scriptpeek', name, version, scripts, url, fetchedAt: new Date().toISOString() };
  await writeFile(path.join(cacheDir, cacheFileName(name, version)), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
}

// Fixed-size worker pool so hundreds of packages do not open hundreds of sockets.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  if (items.length === 0) return out;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// For every install-script candidate record, resolve its real script text.
// source: 'registry' (fetched now) | 'cache' (disk hit) | 'unavailable' (degraded).
// Never throws: fetch/parse/URL failures degrade to a per-package note.
export async function fetchScriptInfo(records, opts = {}) {
  const {
    cacheDir = '.scriptpeek-cache',
    offline = false,
    registry = null,
    fetchImpl = globalThis.fetch,
    concurrency = 8,
    timeoutMs = 15000,
  } = opts;
  const targets = records.filter((r) => r.hasInstallScript !== false);
  return mapPool(targets, concurrency, async (rec) => {
    const base = {
      key: rec.key,
      name: rec.name,
      version: rec.version,
      host: rec.host ?? null,
      hasInstallScript: rec.hasInstallScript,
      note: null,
    };
    const cached = await readCachedScripts(cacheDir, rec.name, rec.version);
    if (cached) return { ...base, source: 'cache', scripts: cached };
    if (offline) {
      return { ...base, source: 'unavailable', scripts: null, note: 'no script text available: offline mode, nothing cached for this package' };
    }
    // No resolved URL and no override → do not guess a registry host; that would
    // silently phone the default registry for packages that may not live there.
    if (!rec.resolved && !registry) {
      return { ...base, source: 'unavailable', scripts: null, note: 'no script text available: lockfile has no resolved URL and no --registry override' };
    }
    try {
      const url = packumentUrl(registryBase(rec, registry), rec.name);
      const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`registry responded with HTTP ${res.status}`);
      const packument = await res.json();
      const scripts = extractScripts(packument, rec.version);
      if (scripts === null) {
        return { ...base, source: 'unavailable', scripts: null, note: `no script text available: version ${rec.version} not found in registry packument` };
      }
      await writeCachedScripts(cacheDir, rec.name, rec.version, scripts, url);
      return { ...base, source: 'registry', scripts };
    } catch (err) {
      return { ...base, source: 'unavailable', scripts: null, note: `no script text available: registry fetch failed (${err?.message ?? err})` };
    }
  });
}
