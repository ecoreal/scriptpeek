#!/usr/bin/env node
// Entry point only — forwards to the CLI router in src/cli.js. No business logic here.
import { runCli } from '../src/cli.js';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (err) {
  // runCli handles its own errors; this is a last-resort guard so the process
  // never dies with an unhandled rejection instead of a normalized exit code.
  console.error(`scriptpeek: unexpected error: ${err?.stack ?? err}`);
  process.exitCode = 2;
}
