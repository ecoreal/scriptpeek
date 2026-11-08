// src/report.js — human-readable table rendering + stable --json serialization.
// Zero dependencies: Node.js standard library only.
import { MAX_PATHS_PER_TARGET } from './graph.js';

export function toJson(value) {
  return JSON.stringify(value, null, 2);
}

const flagLabel = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');

function clip(s, max) {
  s = String(s ?? '');
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function pad(s, w) {
  s = String(s ?? '');
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

// Fixed-width two-space gutter table. Cells are clipped so one long command
// cannot blow the layout; headers/cells are ASCII for cross-terminal safety.
export function renderTable(headers, rows, { clipAt = 60 } = {}) {
  const cells = rows.map((r) => headers.map((_, i) => clip(r[i] ?? '', clipAt)));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => pad(c, widths[i])).join('  ').replace(/\s+$/, '');
  const out = [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of cells) out.push(fmt(r));
  return out.join('\n');
}

export function renderScan(result) {
  const lines = [`scriptpeek scan — ${result.lockfile} (lockfileVersion ${result.lockfileVersion})`];
  const { summary } = result;
  if (summary.listedPackages === 0) {
    lines.push(`no packages with install scripts found (${summary.totalPackages} package(s) total).`);
    return lines.join('\n');
  }
  lines.push(`${summary.listedPackages} of ${summary.totalPackages} package(s) declare or may run lifecycle install scripts:`);
  lines.push('');
  const rows = result.packages.map((p) => [
    `${p.name}@${p.version}`,
    flagLabel(p.hasInstallScript),
    p.host ?? '-',
    p.dependencyPaths.map((names) => names.join(' > ')).join(' | ') || '(unreachable from root)',
  ]);
  lines.push(renderTable(['Package', 'Scripts', 'Registry', 'Dependency path'], rows));
  if (summary.unknownScriptPackages > 0) {
    lines.push('');
    lines.push(`note: ${summary.unknownScriptPackages} package(s) carry no hasInstallScript flag (lockfile v1 keeps none; v2/v3 can lose it, see npm/cli#2606); they are listed as "unknown" and are never silently skipped. Run "scriptpeek scripts" to fetch the actual script text.`);
  }
  const truncatedCount = result.packages.filter((p) => p.pathsTruncated === true).length;
  if (truncatedCount > 0) {
    lines.push('');
    lines.push(`note: dependency path lists for ${truncatedCount} package(s) were truncated at ${MAX_PATHS_PER_TARGET} paths each (marked "pathsTruncated" in --json).`);
  }
  return lines.join('\n');
}

export function renderScripts(result) {
  const lines = [`scriptpeek scripts — ${result.lockfile}${result.offline ? ' (offline: cache only)' : ''}`];
  if (result.results.length === 0) {
    lines.push('no install-script packages to inspect.');
    return lines.join('\n');
  }
  const rows = result.results.map((r) => [
    `${r.name}@${r.version}`,
    r.scripts ? Object.entries(r.scripts).map(([k, v]) => `${k}: ${v}`).join('; ') || '(none declared)' : '-',
    r.source,
    r.note ?? '',
  ]);
  lines.push(renderTable(['Package', 'Script commands', 'Source', 'Note'], rows));
  return lines.join('\n');
}

export function renderDiff(result) {
  const lines = [`scriptpeek diff — ${result.old} -> ${result.new}`];
  if (result.events.length === 0) {
    lines.push('no script-related changes detected.');
  } else {
    lines.push('');
    lines.push(renderTable(
      ['Type', 'Severity', 'Package', 'Change'],
      result.events.map((e) => [e.type, e.severity, e.name, e.type === 'added-script-package' ? `new: ${e.to}` : `${e.from ?? '(none)'} -> ${e.to ?? '(none)'}`]),
    ));
  }
  lines.push('');
  lines.push(`summary: ${result.summary.addedScriptPackages} added script package(s), ${result.summary.versionChanges} version change(s), ${result.summary.registryChanges} registry change(s)`);
  lines.push(`exit: ${result.exitCode}${result.noFail ? ' (--no-fail)' : ''}`);
  return lines.join('\n');
}

export function renderExplain(result) {
  const lines = [`scriptpeek explain — ${result.package} in ${result.lockfile}`];
  if (!result.found) {
    lines.push(`package not found in lockfile: ${result.package}`);
    return lines.join('\n');
  }
  for (const m of result.matches) {
    lines.push('');
    lines.push(`${m.name}@${m.version} — install script: ${flagLabel(m.hasInstallScript)}${m.host ? ` — registry: ${m.host}` : ''}`);
    if (m.paths.length === 0) lines.push('  (not reachable from the project root)');
    for (const p of m.paths) lines.push(`  - ${p.join(' > ')}`);
    if (m.pathsTruncated === true) lines.push(`  (path list truncated at ${MAX_PATHS_PER_TARGET} entries)`);
  }
  return lines.join('\n');
}
