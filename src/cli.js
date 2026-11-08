// src/cli.js — zero-dependency argv parsing, help text, command dispatch and
// exit-code normalization. Exit code contract:
//   0 clean · 1 risk found or usage error · 2 input missing or failed to parse.
import { readFileSync } from 'node:fs';
import { loadLockfile, LockfileError } from './lockfile.js';
import { buildGraph, allPaths, pathNames } from './graph.js';
import { fetchScriptInfo } from './scripts.js';
import { diffRecords, diffExitCode, countEvents } from './diff.js';
import * as report from './report.js';

// Read at import time (not packaged via JSON import: keeps Node 18 free of
// experimental import-attribute warnings).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const VERSION = pkg.version;

const DEFAULT_LOCKFILE = 'package-lock.json';
const DEFAULT_CACHE_DIR = '.scriptpeek-cache';

const defaultIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

// ---- argv parsing -----------------------------------------------------------

// spec: { boolean: ['--json', ...], value: ['--cache-dir', ...] }.
// '-h'/'--help' are always boolean. Supports "--flag value" and "--flag=value".
// Returns { positionals, flags } or { error } on unknown/malformed options.
function parseArgs(argv, spec = {}) {
  const boolean = new Set([...(spec.boolean ?? []), '--help', '-h']);
  const value = new Set(spec.value ?? []);
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length > 1)) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      let inline = eq === -1 ? undefined : arg.slice(eq + 1);
      if (boolean.has(name)) {
        if (inline !== undefined) return { error: `option ${name} takes no value` };
        flags[name] = true;
      } else if (value.has(name)) {
        if (inline === undefined) inline = argv[++i];
        if (inline === undefined || inline === '') return { error: `option ${name} requires a value` };
        flags[name] = inline;
      } else {
        return { error: `unknown option ${name}` };
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

// ---- help text ---------------------------------------------------------------

function usageText() {
  return [
    'scriptpeek — See what an npm lockfile will run before you install it.',
    '',
    'Usage:',
    '  scriptpeek <command> [options]',
    '',
    'Commands:',
    '  scan                  List every package in package-lock.json that will run lifecycle scripts.',
    '  scripts               Fetch real preinstall/install/postinstall/prepack text from the registry.',
    '  diff <old> [new]      Diff two lockfiles for script-related changes (new defaults to package-lock.json).',
    '  explain <package>     Show every dependency path from the project root to a package.',
    '',
    'Common options:',
    '  --json                Emit machine-readable JSON (stable schema).',
    '  --lockfile <path>     Lockfile to read (default: package-lock.json).',
    '  -h, --help            Show help (general or per command).',
    '  --version             Print the version.',
    '',
    'Exit codes:',
    '  0  clean',
    '  1  risk found or usage error',
    '  2  input missing or failed to parse',
    '',
    'Run "scriptpeek <command> --help" for command-specific options.',
  ].join('\n');
}

const HELP = {
  scan: [
    'Usage: scriptpeek scan [options]',
    '',
    'List every package in the lockfile that will run lifecycle install scripts',
    '(hasInstallScript), with its resolved registry host and every dependency path',
    'from the project root. Packages whose install-script status is not recorded',
    '(lockfile v1 keeps no flag; v2/v3 may lose it to npm/cli#2606) are listed',
    'with "unknown" status, never skipped, and can be confirmed via "scripts".',
    '',
    'Options:',
    '  --json                Emit machine-readable JSON (stable schema).',
    '  --lockfile <path>     Lockfile to read (default: package-lock.json).',
    '  -h, --help            Show this help.',
    '',
    'Exit codes: 0 parsed and listed; 1 usage error; 2 lockfile missing/invalid/unsupported.',
  ].join('\n'),
  scripts: [
    'Usage: scriptpeek scripts [options]',
    '',
    'For every install-script package found by "scan", fetch the real',
    'preinstall/install/postinstall/prepack command text from the registry',
    'packument. The default registry host comes from each package\'s resolved URL;',
    'results are cached on disk, and a cache hit never touches the network.',
    '',
    'Options:',
    '  --json                Emit machine-readable JSON (stable schema).',
    '  --lockfile <path>     Lockfile to read (default: package-lock.json).',
    '  --cache-dir <dir>     Cache directory (default: .scriptpeek-cache).',
    '  --registry <url>      Use this registry base URL for every package.',
    '  --offline             Cache only: never use the network; packages without',
    '                        cached text are reported as unavailable.',
    '  -h, --help            Show this help.',
    '',
    'Exit codes: 0 done (degraded results are reported, not fatal); 1 usage error; 2 lockfile missing/invalid/unsupported.',
  ].join('\n'),
  diff: [
    'Usage: scriptpeek diff <old-lockfile> [new-lockfile]',
    '',
    'Compare two lockfiles and report three kinds of events: added packages that',
    'run install scripts, install-script packages that changed version, and',
    'packages whose resolved registry host changed. Exits 1 when a new',
    'install-script package appears (CI gate); --no-fail forces exit 0.',
    '',
    'Options:',
    '  --json                Emit machine-readable JSON (stable schema).',
    '  --no-fail             Always exit 0, even when new script packages are found.',
    '  -h, --help            Show this help.',
    '',
    'Exit codes: 0 clean (or --no-fail); 1 new install-script package or usage error; 2 lockfile missing/invalid/unsupported.',
  ].join('\n'),
  explain: [
    'Usage: scriptpeek explain <package> [options]',
    '',
    'Print every dependency path from the project root to the given package —',
    'all of them, including multiple installed versions. Dependency cycles are',
    'cut short, never looped forever. Also reports whether it runs install scripts.',
    '',
    'Options:',
    '  --json                Emit machine-readable JSON (stable schema).',
    '  --lockfile <path>     Lockfile to read (default: package-lock.json).',
    '  -h, --help            Show this help.',
    '',
    'Exit codes: 0 package found; 1 package not found or usage error; 2 lockfile missing/invalid/unsupported.',
  ].join('\n'),
};

// ---- shared core ---------------------------------------------------------------

// Install-script candidates: hasInstallScript true, or null (v1 = unknowable).
// Packages explicitly flagged false never run scripts and are excluded.
// Attach every root->package dependency path (names) for display.
function collectScriptPackages(lock) {
  const graph = buildGraph(lock);
  const rows = [];
  for (const rec of lock.records) {
    if (rec.hasInstallScript === false) continue;
    const { paths, truncated } = allPaths(graph, rec.key);
    rows.push({
      key: rec.key,
      name: rec.name,
      version: rec.version,
      resolved: rec.resolved,
      host: rec.host,
      hasInstallScript: rec.hasInstallScript,
      pathsTruncated: truncated,
      dependencyPaths: paths.map((p) => pathNames(graph, p, lock.projectName)),
    });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : 1));
  return rows;
}

// ---- commands ------------------------------------------------------------------

async function cmdScan(argv, io) {
  const p = parseArgs(argv, { boolean: ['--json'], value: ['--lockfile'] });
  if (p.error) { io.err(`scriptpeek scan: ${p.error}\n\n${HELP.scan}`); return 1; }
  if (p.flags['--help']) { io.out(HELP.scan); return 0; }
  if (p.positionals.length > 0) {
    io.err(`scriptpeek scan: unexpected argument "${p.positionals[0]}" (use --lockfile <path>)\n\n${HELP.scan}`);
    return 1;
  }
  const lockPath = p.flags['--lockfile'] ?? DEFAULT_LOCKFILE;
  const lock = loadLockfile(lockPath); // LockfileError -> exit 2 via runCli
  const packages = collectScriptPackages(lock);
  const result = {
    tool: 'scriptpeek',
    version: VERSION,
    command: 'scan',
    lockfile: lockPath,
    lockfileVersion: lock.lockfileVersion,
    projectName: lock.projectName,
    packages,
    summary: {
      totalPackages: lock.records.length,
      listedPackages: packages.length,
      scriptPackages: packages.filter((x) => x.hasInstallScript === true).length,
      unknownScriptPackages: packages.filter((x) => x.hasInstallScript === null).length,
    },
  };
  if (p.flags['--json']) io.out(report.toJson(result));
  else io.out(report.renderScan(result));
  return 0;
}

async function cmdScripts(argv, io) {
  const p = parseArgs(argv, { boolean: ['--json', '--offline'], value: ['--lockfile', '--cache-dir', '--registry'] });
  if (p.error) { io.err(`scriptpeek scripts: ${p.error}\n\n${HELP.scripts}`); return 1; }
  if (p.flags['--help']) { io.out(HELP.scripts); return 0; }
  if (p.positionals.length > 0) {
    io.err(`scriptpeek scripts: unexpected argument "${p.positionals[0]}"\n\n${HELP.scripts}`);
    return 1;
  }
  const lockPath = p.flags['--lockfile'] ?? DEFAULT_LOCKFILE;
  const cacheDir = p.flags['--cache-dir'] ?? DEFAULT_CACHE_DIR;
  const offline = p.flags['--offline'] === true;
  const registry = p.flags['--registry'] ?? null;
  const lock = loadLockfile(lockPath);
  const targets = collectScriptPackages(lock);
  const results = await fetchScriptInfo(targets, { cacheDir, offline, registry });
  const result = {
    tool: 'scriptpeek',
    version: VERSION,
    command: 'scripts',
    lockfile: lockPath,
    offline,
    registry,
    results,
    summary: {
      total: results.length,
      fetched: results.filter((r) => r.source === 'registry').length,
      cached: results.filter((r) => r.source === 'cache').length,
      unavailable: results.filter((r) => r.source === 'unavailable').length,
    },
  };
  if (p.flags['--json']) io.out(report.toJson(result));
  else io.out(report.renderScripts(result));
  return 0;
}

async function cmdDiff(argv, io) {
  const p = parseArgs(argv, { boolean: ['--json', '--no-fail'] });
  if (p.error) { io.err(`scriptpeek diff: ${p.error}\n\n${HELP.diff}`); return 1; }
  if (p.flags['--help']) { io.out(HELP.diff); return 0; }
  const oldPath = p.positionals[0];
  if (!oldPath) { io.err('scriptpeek diff: missing <old-lockfile> argument\n\n' + HELP.diff); return 1; }
  const newPath = p.positionals[1] ?? DEFAULT_LOCKFILE;
  const oldLock = loadLockfile(oldPath);
  const newLock = loadLockfile(newPath);
  const events = diffRecords(oldLock, newLock);
  const noFail = p.flags['--no-fail'] === true;
  const exitCode = diffExitCode(events, { noFail });
  const result = {
    tool: 'scriptpeek',
    version: VERSION,
    command: 'diff',
    old: oldPath,
    new: newPath,
    noFail,
    events,
    summary: {
      addedScriptPackages: countEvents(events, 'added-script-package'),
      versionChanges: countEvents(events, 'version-change'),
      registryChanges: countEvents(events, 'registry-change'),
    },
    exitCode,
  };
  if (p.flags['--json']) io.out(report.toJson(result));
  else io.out(report.renderDiff(result));
  return exitCode;
}

async function cmdExplain(argv, io) {
  const p = parseArgs(argv, { boolean: ['--json'], value: ['--lockfile'] });
  if (p.error) { io.err(`scriptpeek explain: ${p.error}\n\n${HELP.explain}`); return 1; }
  if (p.flags['--help']) { io.out(HELP.explain); return 0; }
  const pkgName = p.positionals[0];
  if (!pkgName) { io.err('scriptpeek explain: missing <package> argument\n\n' + HELP.explain); return 1; }
  const lockPath = p.flags['--lockfile'] ?? DEFAULT_LOCKFILE;
  const lock = loadLockfile(lockPath);
  const graph = buildGraph(lock);
  const matches = lock.records
    .filter((r) => r.name === pkgName)
    .map((rec) => {
      const { paths, truncated } = allPaths(graph, rec.key);
      return {
        key: rec.key,
        name: rec.name,
        version: rec.version,
        resolved: rec.resolved,
        host: rec.host,
        hasInstallScript: rec.hasInstallScript,
        pathsTruncated: truncated,
        paths: paths.map((pathKeys) => pathNames(graph, pathKeys, lock.projectName)),
      };
    });
  matches.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const found = matches.length > 0;
  const result = {
    tool: 'scriptpeek',
    version: VERSION,
    command: 'explain',
    lockfile: lockPath,
    package: pkgName,
    found,
    isScriptPackage: matches.some((m) => m.hasInstallScript === true),
    matches,
  };
  if (p.flags['--json']) io.out(report.toJson(result));
  else io.out(report.renderExplain(result));
  return found ? 0 : 1;
}

const COMMANDS = { scan: cmdScan, scripts: cmdScripts, diff: cmdDiff, explain: cmdExplain };

// Dispatch and normalize. Returns the process exit code; the bin assigns it to
// process.exitCode (never process.exit) so stdout/stderr flush naturally.
export async function runCli(argv, io = defaultIo) {
  const first = argv[0];
  if (first === undefined) { io.err(usageText()); return 1; }
  if (first === '--help' || first === '-h') { io.out(usageText()); return 0; }
  if (first === '--version') { io.out(VERSION); return 0; }
  const handler = COMMANDS[first];
  if (!handler) {
    io.err(`scriptpeek: unknown command "${first}"\n\n${usageText()}`);
    return 1;
  }
  try {
    return await handler(argv.slice(1), io);
  } catch (err) {
    if (err instanceof LockfileError) {
      io.err(`scriptpeek: ${err.message}`);
      return 2;
    }
    io.err(`scriptpeek: unexpected error: ${err && err.stack ? err.stack : String(err)}`);
    return 2;
  }
}
