<div align="center">

# scriptpeek

**See what an npm lockfile will run before you install it — audit lifecycle scripts in one zero-dependency command.**

[![CI](https://github.com/ecoreal/scriptpeek/actions/workflows/ci.yml/badge.svg)](https://github.com/ecoreal/scriptpeek/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node: >=18.17](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](./package.json)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)
[![tests: 59 passing](https://img.shields.io/badge/tests-59%20passing-brightgreen.svg)](https://github.com/ecoreal/scriptpeek/actions/workflows/ci.yml)

[English](./README.md) | [中文](./README.zh-CN.md)

</div>

`scriptpeek` is a supply-chain hygiene tool for npm projects. It reads
`package-lock.json` and answers one question before you run `npm ci` /
`npm install`: **which packages will execute lifecycle scripts
(`preinstall` / `install` / `postinstall` / `prepack`), with what command
text, pulled in through which dependency paths — and what changed since the
lockfile you trusted last time.**

- **Zero dependencies.** Node.js standard library only. Requires Node ≥ 18.17, ESM (`"type": "module"`).
- **Read-only.** It never installs anything and never executes a package's scripts.
- **Stable `--json`** on every command, designed for machine consumption.

## Quick look

Transcripts from real runs against the repository's test fixtures
(a lockfile of 7 packages: three declare install scripts, four carry no
`hasInstallScript` flag and are listed as unknown):

```console
$ scriptpeek scan
scriptpeek scan — package-lock.json (lockfileVersion 3)
7 of 7 package(s) declare or may run lifecycle install scripts:

Package         Scripts  Registry            Dependency path
--------------  -------  ------------------  ------------------------------------------------------------
alpha@1.0.0     unknown  registry.npmjs.org  fixture-app > alpha
beta@1.0.0      unknown  registry.npmjs.org  fixture-app > beta
devonly@1.0.0   yes      registry.npmjs.org  fixture-app > devonly
postcorg@1.5.0  yes      registry.npmjs.org  fixture-app > beta > postcorg
shared@0.9.0    unknown  registry.npmjs.org  fixture-app > alpha > shared
shared@1.0.0    unknown  registry.npmjs.org  fixture-app > beta > shared | fixture-app > toolkit > shared
toolkit@2.0.0   yes      registry.npmjs.org  fixture-app > toolkit

note: 4 package(s) carry no hasInstallScript flag (lockfile v1 keeps none; v2/v3 can lose it, see npm/cli#2606); they are listed as "unknown" and are never silently skipped. Run "scriptpeek scripts" to fetch the actual script text.

$ scriptpeek diff lockfile.baseline.json
scriptpeek diff — lockfile.baseline.json -> package-lock.json

Type                  Severity  Package        Change
--------------------  --------  -------------  ----------
added-script-package  high      sneakyinstall  new: 2.0.0

summary: 1 added script package(s), 0 version change(s), 0 registry change(s)
exit: 1
```

## Install

```bash
npx scriptpeek scan
```

That's it — no project files are touched. To have the command available
everywhere:

```bash
npm install -g scriptpeek
```

## Usage

`scriptpeek` has four commands. Every command accepts `--json` for
machine-readable output; `scriptpeek --help` prints the full overview:

```console
$ scriptpeek --help
scriptpeek — See what an npm lockfile will run before you install it.

Usage:
  scriptpeek <command> [options]

Commands:
  scan                  List every package in package-lock.json that will run lifecycle scripts.
  scripts               Fetch real preinstall/install/postinstall/prepack text from the registry.
  diff <old> [new]      Diff two lockfiles for script-related changes (new defaults to package-lock.json).
  explain <package>     Show every dependency path from the project root to a package.

Common options:
  --json                Emit machine-readable JSON (stable schema).
  --lockfile <path>     Lockfile to read (default: package-lock.json).
  -h, --help            Show help (general or per command).
  --version             Print the version.

Exit codes:
  0  clean
  1  risk found or usage error
  2  input missing or failed to parse

Run "scriptpeek <command> --help" for command-specific options.
```

### `scriptpeek scan [--json] [--lockfile <path>]`

Reads the lockfile (lockfileVersion 1/2/3) and lists every package that will
run lifecycle scripts, with `name@version`, the resolved registry host, and
all dependency paths from the project root.

Detection uses the lockfile's own `hasInstallScript` flag. npm never writes
`false` — and [npm/cli#2606](https://github.com/npm/cli/issues/2606) loses
the flag entirely on script packages in lockfiles touched by npm 7 through
9.x (esbuild/electron class packages). A package whose status is therefore
unknown is listed with **unknown** instead of being skipped — a package that
might run scripts is never silently filtered out. `scriptpeek scripts`
tells you the truth from the registry.

### `scriptpeek scripts [--cache-dir <dir>] [--offline] [--registry <url>]`

For every package listed by `scan`, fetch the packument from the registry and
extract the real `preinstall` / `install` / `postinstall` / `prepack` command
text. The default registry host follows each package's resolved URL; results
are written to the cache directory (default `.scriptpeek-cache/`), and a cache
hit never touches the network.

- `--offline` — use the cache only. Packages without cached text are reported
  as **unavailable** with an explicit "no script text available" note and the
  lockfile's own flag; the command still exits 0.
- `--registry <url>` — override the registry base URL for every package.
- Fetch failures (HTTP errors, timeouts, bad responses) degrade per package
  into an explanatory note; the run never crashes.

### `scriptpeek diff <old-lockfile> [new-lockfile] [--json] [--no-fail]`

Compares two lockfiles and reports exactly three kinds of events:

| Event                  | Meaning                                                    | Severity |
| ---------------------- | ---------------------------------------------------------- | -------- |
| `added-script-package` | a package not present before that runs install scripts      | high     |
| `version-change`       | an existing package whose installed version changed         | high/low |
| `registry-change`      | an existing package whose resolved registry host changed    | high     |

A new install-script package is the classic poisoning signal, so it exits
**1** by default (CI gate). `--no-fail` forces exit **0**. When
`<new-lockfile>` is omitted it defaults to `./package-lock.json`, so
`scriptpeek diff lockfile.baseline.json` compares your baseline against the
current tree.

### `scriptpeek explain <package> [--json] [--lockfile <path>]`

Prints every dependency path from the project root to the package — all of
them, including multiple installed copies at different nesting levels.
Dependency cycles are cut short (each node appears at most once per path), so
output always terminates. Exits 1 when the package is not in the lockfile.

## What it scans

- **Input** — one `package-lock.json` (lockfileVersion 1, 2 or 3), read-only.
  Nothing is installed, nothing is executed, no package script of your own or
  anyone else's ever runs.
- **Lifecycle scripts considered** — exactly the four fields npm runs at
  install time: `preinstall`, `install`, `postinstall`, `prepack`.
- **Detection source** — npm's own `hasInstallScript` flag. npm writes it
  only when true and never `false`, and it can be lost entirely
  ([npm/cli#2606](https://github.com/npm/cli/issues/2606)); an entry without
  the flag is therefore listed as `unknown` — never silently skipped. Only an
  explicit `hasInstallScript: false` excludes a package.
- **Registry script text** — `scripts` fetches the packument and extracts the
  real command text for those four fields; results are cached on disk and
  re-runs work fully offline.
- **Scope of change detection** — `diff` watches for new install-script
  packages, installed-version changes and resolved-registry-host changes.
- **`devDependencies` count too** — `npm ci` installs and runs their scripts.

What it deliberately does **not** do: it is not a malware analyzer, not a
vulnerability database, and not a sandbox. It shows you facts about the
lockfile you are about to install from — see [Why](#why) for where dedicated
tools take over.

## Exit codes

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 0    | clean                                                                     |
| 1    | risk found (diff: new script package; explain: not found) or usage error   |
| 2    | input missing or failed to parse (lockfile missing / invalid JSON / unsupported lockfileVersion) |

## JSON schema

Every command accepts `--json` and prints a single JSON document with a
stable field set (asserted by the test suite as a schema snapshot):

```jsonc
// scan
{
  "tool": "scriptpeek",
  "version": "0.1.0",
  "command": "scan",
  "lockfile": "package-lock.json",
  "lockfileVersion": 3,
  "projectName": "your-app",
  "packages": [
    {
      "key": "node_modules/toolkit",
      "name": "toolkit",
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/toolkit/-/toolkit-2.0.0.tgz",
      "host": "registry.npmjs.org",
      "hasInstallScript": true,
      "pathsTruncated": false,
      "dependencyPaths": [["your-app", "toolkit"]]
    }
  ],
  "summary": { "totalPackages": 7, "listedPackages": 7, "scriptPackages": 3, "unknownScriptPackages": 4 }
}
```

`scripts` adds per-package `source` (`registry` | `cache` | `unavailable`),
`scripts` (the extracted command text) and `note` (always present, null when
nothing is wrong). `diff` emits `events` with `{type, name, severity, from, to}`
plus `exitCode` (`from`/`to` may be `null`, e.g. an origin repointed to a
`file:` tarball); `explain` emits `found`, `isScriptPackage` and `matches` with
their `paths`. `pathsTruncated` marks path lists cut at the enumeration cap.

## How detection works

- npm records `hasInstallScript: true` in the lockfile when a package declares
  install scripts, and **never writes `false`** (arborist's lockfile writer
  skips falsy fields).
- The flag can therefore be missing in two very different situations: a plain
  "no scripts" encoding, and the lost-flag bug
  [npm/cli#2606](https://github.com/npm/cli/issues/2606) — open since 2021,
  reported through npm 9.x, hitting esbuild/electron-style packages on
  lockfiles upgraded from v1. scriptpeek treats a missing flag as **unknown**
  and lists such packages; only an explicit `hasInstallScript: false` is
  authoritative. Expect many `unknown` rows on real lockfiles — that is the
  price of never silently skipping a package that might run scripts.
  `scripts` (cacheable, offline) resolves them.
- Dependency paths come from a graph built over the installed tree, with
  dependencies resolved by npm's nearest-`node_modules` rule (no semver range
  evaluation needed: the lockfile already fixed the layout). Enumeration is
  capped per package — see [Limitations](#limitations).

## Why

Most tooling answers a different question than the one scriptpeek targets.
This is a neutral summary of each tool's primary, publicly documented purpose
at the time of writing — they solve different problems and can complement
each other; verify details against each project's current docs.

|                                     | scriptpeek                                  | `npm audit`                  | lockfile-lint                       | `@lavamoat/allow-scripts`                | Socket (socket.dev)                    |
| ----------------------------------- | ------------------------------------------- | ---------------------------- | ----------------------------------- | ---------------------------------------- | -------------------------------------- |
| Primary question                    | which packages will run install scripts — and what exactly | is there a known CVE in the tree | are the lockfile's resolved URLs sane | which install scripts should be allowed to run | is any package behaving maliciously   |
| Where it runs                       | plain CLI on your machine                   | plain CLI, bundled with npm  | plain CLI on your machine           | inside your project's own npm install    | CLI backed by the Socket cloud service |
| Needs the network                   | `scan`/`diff`/`explain`: no; `scripts`: optional (cacheable, `--offline`) | yes (advisory database) | no | no | yes |
| Shows the actual script command text before you install | yes — fetched from the registry, cached, works offline | no | no | records them into its policy during install | behavioral signals, not script-text-focused |
| Lockfile-to-lockfile diff as a CI gate | yes — `diff` exits 1 on a newly added script package | no | no | no (policy-based instead) | via platform alerts |
| Extra footprint                     | zero dependencies, nothing else to set up   | none                         | one more CLI tool                   | install-flow + policy-file integration   | an account and API access              |

scriptpeek's niche: a zero-dependency, read-only pre-flight check over the
lockfile itself — including environments where you cannot or will not install
anything extra, and the specific question "what will install scripts run on
this machine?".

## Suggested CI gating

```bash
scriptpeek diff lockfile.baseline.json
```

Commit a known-good lockfile as the baseline; `diff` fails the job when a new
install-script package sneaks in. Run `scan`/`scripts` in the same job for a
full pre-install listing, and review `registry-change` events manually.

## Limitations

- **Missing `hasInstallScript` flags mean "unknown", not "clean"** — see
  [npm/cli#2606](https://github.com/npm/cli/issues/2606). scan lists every
  such package, so on real lockfiles the output includes most packages;
  resolve unknowns with `scriptpeek scripts` (`--offline` + cache works in
  air-gapped environments).
- **Dependency-path enumeration is capped** at 1000 simple paths per package
  (`pathsTruncated: true`, DFS prefix order). Unbounded enumeration is
  measurable: a 7-layer × 8-wide fully connected DAG yields 262,144 paths for
  a single package; the cap keeps `scan --json` at ~4 MB and milliseconds for
  that shape. Review truncated lists manually when the flag is set.
- `diff` matches packages by name; multiple installed versions of one package
  collapse into one comparison (version sets are reported comma-joined).
  `registry-change` also fires when an origin changes to or from an unhosted
  URL (`from`/`to` may be `null`, e.g. a resolved URL repointed to a `file:`
  tarball).
- Workspace layouts (`packages/*` link entries) are not traversed in v0.1.
- `scripts` fetches packuments over HTTPS by default; in air-gapped
  environments use `--offline` plus a pre-warmed `--cache-dir`.

## Development

```bash
git clone https://github.com/ecoreal/scriptpeek
cd scriptpeek
npm test
```

There is no install step — the project has zero dependencies, so `npm test`
is plain `node --test` (Node ≥ 18.17) and runs fully offline against
synthetic fixtures. Tests spawn the real CLI, serve packuments from a local
`node:http` mock registry on `127.0.0.1`, and keep every cache in a
`mkdtemp` directory — no network access, no real user directories touched.

```console
$ npm test
...
ℹ tests 59
ℹ suites 0
ℹ pass 59
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Layout: `bin/scriptpeek.js` (entry point) → `src/cli.js` (argv parsing, help,
dispatch, exit codes), `src/lockfile.js` (read + normalize v1/2/3),
`src/graph.js` (dependency paths), `src/scripts.js` (registry fetch, cache,
offline), `src/diff.js` (event model), `src/report.js` (human tables +
`--json`). Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Roadmap

Intentions, not commitments — nothing below is implemented in 0.1.0.
Feedback and pull requests are welcome.

- [ ] Traverse workspace / link entries in the dependency graph (currently
      skipped — see [Limitations](#limitations)).
- [ ] Allowlist for `diff`: ignore script packages you have already reviewed
      so a baseline comparison only flags genuinely new ones.
- [ ] A convenience command to pre-warm the script cache on a connected
      machine for air-gapped CI runs.
- [ ] Explore the same script-audit for other lockfile formats
      (`pnpm-lock.yaml`, `yarn.lock`).

## License

[MIT](./LICENSE) © 2026 Jerry Lee (ecoreal)
