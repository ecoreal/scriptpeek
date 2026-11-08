// src/diff.js — set operations over two normalized lockfile record sets.
// Event model (exactly three types, per spec):
//   added-script-package — a package absent before that runs (or may run) install scripts → severity high, gates CI
//   version-change       — an existing package whose installed version set changed
//   registry-change      — an existing package whose resolved registry host changed → severity high
// hasInstallScript === null (lockfile v1 has no flag) is treated as script-capable:
// we cannot rule scripts out, so we stay conservative.
// Zero dependencies: Node.js standard library only.

export const EVENT_TYPES = {
  ADDED_SCRIPT: 'added-script-package',
  VERSION: 'version-change',
  REGISTRY: 'registry-change',
};

// Index records by package name. Multiple installed copies (hoisted + nested)
// collapse to one entry: version set for comparison, host from the shallowest
// (topmost) record since that is the copy resolution picks first in practice.
function indexByName(records) {
  const map = new Map();
  for (const rec of records) {
    const depth = depthOf(rec.key);
    const cur = map.get(rec.name);
    if (!cur) {
      map.set(rec.name, { versions: new Set([rec.version]), host: rec.host, depth, rec });
    } else {
      cur.versions.add(rec.version);
      if (depth < cur.depth || (depth === cur.depth && rec.key < cur.rec.key)) {
        cur.host = rec.host;
        cur.depth = depth;
        cur.rec = rec;
      }
    }
  }
  return map;
}

function depthOf(key) {
  let n = 0;
  for (let i = key.indexOf('node_modules/'); i !== -1; i = key.indexOf('node_modules/', i + 1)) n++;
  return n;
}

export function diffRecords(oldLock, newLock) {
  const oldIdx = indexByName(oldLock.records);
  const newIdx = indexByName(newLock.records);
  const events = [];
  for (const name of [...newIdx.keys()].sort()) {
    const nu = newIdx.get(name);
    const ol = oldIdx.get(name);
    if (!ol) {
      if (nu.rec.hasInstallScript !== false) {
        events.push({ type: EVENT_TYPES.ADDED_SCRIPT, name, severity: 'high', from: null, to: [...nu.versions].sort().join(', ') });
      }
      continue; // plain new packages are not reported per spec
    }
    const isScript = nu.rec.hasInstallScript !== false;
    const fromV = [...ol.versions].sort().join(', ');
    const toV = [...nu.versions].sort().join(', ');
    if (fromV !== toV) {
      events.push({ type: EVENT_TYPES.VERSION, name, severity: isScript ? 'high' : 'low', from: fromV, to: toV });
    }
    // Host must be compared including null transitions: a resolved URL repointed
    // to a file:/local tarball (host null) is exactly the kind of origin change
    // this report exists for, so "either side null but they differ" is an event.
    // Both sides null (no origin on either lockfile) stays silent — nothing to compare.
    if (ol.host !== nu.host && (ol.host || nu.host)) {
      events.push({ type: EVENT_TYPES.REGISTRY, name, severity: 'high', from: ol.host, to: nu.host });
    }
  }
  return events;
}

export const countEvents = (events, type) => events.filter((e) => e.type === type).length;

export const hasFailEvent = (events) => countEvents(events, EVENT_TYPES.ADDED_SCRIPT) > 0;

// Exit code: 1 only when a new install-script package appeared; --no-fail forces 0.
export function diffExitCode(events, { noFail = false } = {}) {
  return noFail ? 0 : hasFailEvent(events) ? 1 : 0;
}
