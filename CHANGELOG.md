# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-09

### Added

- `scriptpeek scan [--json] [--lockfile <path>]`: list every package in
  `package-lock.json` (lockfileVersion 1/2/3) that runs lifecycle install
  scripts, with `name@version`, resolved registry host and all dependency
  paths from the project root.
- `scriptpeek scripts [--cache-dir <dir>] [--offline] [--registry <url>]`:
  fetch real `preinstall`/`install`/`postinstall`/`prepack` command text from
  registry packuments, with on-disk caching and offline degradation.
- `scriptpeek diff <old-lockfile> [new-lockfile] [--json] [--no-fail]`:
  report added script packages (exit 1 by default, CI gate), version changes
  and registry-host changes between two lockfiles.
- `scriptpeek explain <package> [--json] [--lockfile <path>]`: print every
  dependency path from the root to a package; cycles are cut short, never
  looped.
- Stable `--json` schema on every command; unified exit codes (0 clean /
  1 risk found or usage error / 2 input missing or parse failure).
- Zero dependencies (Node.js standard library only, ESM, Node >= 18.17).

### Security

- A missing `hasInstallScript` flag in v2/v3 lockfiles is treated as
  **unknown**, and unknown packages are listed instead of silently skipped.
  npm only writes the flag when true (arborist skips falsy fields), and
  [npm/cli#2606](https://github.com/npm/cli/issues/2606) loses it entirely on
  script packages in lockfiles touched by npm 7 through 9.x (esbuild/electron
  class packages). Only an explicit `hasInstallScript: false` is authoritative.
- `diff` emits `registry-change` when a package's resolved origin changes to
  or from an unhosted URL (e.g. a `file:` tarball), not only between two
  registry hosts.
- Dependency-path enumeration is capped at 1000 simple paths per package
  (`pathsTruncated: true` in JSON output) so pathologically dense dependency
  graphs cannot produce unbounded output.

[0.1.0]: https://github.com/ecoreal/scriptpeek/releases/tag/v0.1.0
