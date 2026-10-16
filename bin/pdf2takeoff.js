#!/usr/bin/env node
// pdf2takeoff CLI shim — runs the TypeScript entry directly via Node's
// native type stripping (Node >= 22.6; no bundler, no build step).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { constants } from 'node:os';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'headless', 'cli.ts');
const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
// a native crash (e.g. SIGSEGV in the canvas addon) leaves no status and no
// message of its own — say so rather than exiting 1 silently
if (result.signal) {
  process.stderr.write(`pdf2takeoff: crashed (${result.signal})\n`);
  process.exit(128 + (constants.signals[result.signal] ?? 0));
}
process.exit(result.status ?? 1);
