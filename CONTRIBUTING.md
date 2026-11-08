# Contributing to scriptpeek

Thanks for taking the time to contribute. This document covers what you need
to know to work on the codebase productively.

## Development setup

- **Node ≥ 18.17** (see `engines` in `package.json`). No npm install step is
  needed: the project has **zero runtime and dev dependencies**, so `npm test`
  is plain `node --test` and works immediately after cloning.

```bash
git clone https://github.com/ecoreal/scriptpeek
cd scriptpeek
npm test
node bin/scriptpeek.js --help
```

## Project layout

| File                 | Responsibility                                                             |
| -------------------- | -------------------------------------------------------------------------- |
| `bin/scriptpeek.js`  | Entry point only — forwards to `src/cli.js`, normalizes the exit code.      |
| `src/cli.js`         | argv parsing, help text, command dispatch, exit-code contract.              |
| `src/lockfile.js`    | Read + normalize `package-lock.json` (lockfileVersion 1/2/3), error classes.|
| `src/graph.js`       | Dependency graph, nearest-`node_modules` resolution, simple-path enumeration.|
| `src/scripts.js`     | Registry packument fetching (injectable fetch), script extraction, disk cache, offline degradation. |
| `src/diff.js`        | Lockfile-to-lockfile event model (`added-script-package`, `version-change`, `registry-change`). |
| `src/report.js`      | Human-readable tables and stable `--json` serialization.                    |
| `test/*.test.js`     | `node:test` suites, including end-to-end CLI spawns.                        |
| `test/fixtures/`     | Synthetic lockfiles and packuments; nothing here is fetched from the real network. |

## Ground rules

These are the invariants that keep scriptpeek small and safe to run anywhere.
A PR that breaks one is unlikely to be merged; a PR that needs an exception
should open an issue first.

1. **Zero dependencies.** Node.js standard library only — no runtime *and* no
   dev dependencies. `package.json` must keep an empty (or absent)
   `dependencies`/`devDependencies` section.
2. **Tests run fully offline.** Tests spawn the real CLI; registry responses
   come from a local `node:http` mock server bound to `127.0.0.1`, and every
   cache goes into a `mkdtemp` temporary directory. No test may touch the real
   registry or read/write real user directories.
3. **Exit-code contract.** `0` clean, `1` risk found or usage error, `2`
   input missing or failed to parse. The contract is asserted by tests; keep
   it intact.
4. **`--json` schema is stable.** Fields asserted by the schema-snapshot tests
   must not be renamed or removed. Additive changes are fine; breaking ones
   require an issue and a major version bump.
5. **Conservative detection.** A package that *might* run install scripts is
   listed, never silently skipped. Concretely: any lockfile entry whose
   `hasInstallScript` status is not recorded counts as unknown — lockfile v1
   keeps no flag, npm never writes `false` (arborist skips falsy fields), and
   [npm/cli#2606](https://github.com/npm/cli/issues/2606) loses the flag on
   script packages in v2/v3 lockfiles. Only an explicit
   `hasInstallScript: false` may exclude an entry. Degrade with an explicit
   note instead of crashing.
6. **ESM.** `"type": "module"` — use `import`/`export`; avoid CommonJS.

## Making changes

- Keep PRs focused: one fix or feature per PR.
- Add or update tests for any behavior change. Bug reports ideally come with a
  failing test first.
- Output changes (tables, wording) usually require updating assertions — check
  `test/report.test.js` and `test/cli.test.js`.
- Update `README.md` **and** `README.zh-CN.md` together; they mirror each
  other. Console examples in the READMEs should be real tool output, never
  invented.
- CI runs the suite on Linux/macOS/Windows × Node 18/20/22/24
  (`.github/workflows/ci.yml`), so avoid Unix-only assumptions in code and
  tests (e.g. hard-coded `/` paths, `grep` in test scripts).

## Reporting bugs and proposing features

- Bugs: [bug_report](./.github/ISSUE_TEMPLATE/bug_report.yml)
- Feature ideas: [feature_request](./.github/ISSUE_TEMPLATE/feature_request.yml)
- Security-sensitive findings (e.g. ways scriptpeek's own detection can be
  bypassed): follow [SECURITY.md](./SECURITY.md) — please do not open a public
  issue for those.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE) that covers this project.
