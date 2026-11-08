# Security Policy

## Reporting a vulnerability

Please do **not** report security issues through public GitHub issues, pull
requests, or discussions.

Use GitHub's private security reporting for this repository:

- **Preferred:** open a private [security advisory](
  https://github.com/ecoreal/scriptpeek/security/advisories/new) on GitHub.
- If GitHub advisories are unavailable to you, open a minimal public issue
  asking the maintainer to enable a private channel, without including any
  technical detail.

Include as much of the following as applies:

- scriptpeek version (`scriptpeek --version`) and Node.js version
- Operating system
- A minimal, self-contained reproduction (lockfile snippet, command line,
  observed output)
- Your assessment of impact

You can expect an initial acknowledgment within a few business days, followed
by an honest timeline once the report is triaged. If the report is confirmed,
a fix will be released and the advisory will be published (you will be
credited unless you prefer to stay anonymous).

## Supported versions

Only the latest released minor line receives security fixes.

| Version  | Supported |
| -------- | --------- |
| 0.1.x    | yes       |
| < 0.1.0  | no        |

## Scope notes

scriptpeek is a read-only audit tool. Things that are in scope:

- Ways its **detection** can be made to miss install-script packages that will
  actually run scripts (e.g. lockfile shapes that evade `hasInstallScript`
  handling, v1 tree quirks, graph/path enumeration bugs).
- Its own behavior as a supply-chain surface: what it fetches, how the disk
  cache (`.scriptpeek-cache/`) is written and validated, argv/JSON parsing,
  path handling.

Out of scope: vulnerabilities in npm, the npm registry, or third-party
packages scriptpeek merely *reports on* — please report those to the
respective project. A report that a lockfile contains a malicious package is
working-as-intended input, not a vulnerability in scriptpeek.

## Known upstream risk: missing `hasInstallScript` flags

npm writes `hasInstallScript` into the lockfile only when it is true and
never writes `false` (arborist's lockfile writer skips falsy fields).
Separately, [npm/cli#2606](https://github.com/npm/cli/issues/2606) (open,
reported on npm 7 through 9.x) loses the flag entirely on script packages —
classically esbuild/electron — in lockfiles carried over from v1. scriptpeek
therefore treats a missing flag as **unknown** and lists such packages
instead of skipping them; only an explicit `hasInstallScript: false` is
authoritative. Other lockfile shapes that could hide script packages from
this handling remain in scope under "Reporting a vulnerability" above.
