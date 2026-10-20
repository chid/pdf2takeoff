#!/usr/bin/env node
// Small local command entry point. No installs, Git changes or deployment.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const experiment = 'experiments/legend-takeoff/';
const checks = [
  ['node_modules/typescript/bin/tsc', '--noEmit', '--target', 'es2022', '--module', 'esnext',
    '--moduleResolution', 'bundler', '--lib', 'es2022,dom,dom.iterable', '--strict',
    '--noUnusedLocals', '--skipLibCheck', '--allowImportingTsExtensions', '--allowJs',
    experiment + 'workspace.ts'],
  [experiment + 'check-pricing.mjs'],
  ['--experimental-strip-types', experiment + 'check-workspace.mjs'],
];
const commands = {
  dev: [[experiment + 'serve.mjs']],
  check: checks,
  build: [...checks, ['node_modules/vite/bin/vite.js', 'build', '--config', experiment + 'vite.config.mjs']],
  bench: [['--experimental-strip-types', 'scripts/takeoff-bench.mjs']],
  'trade-pages': [[experiment + 'make-trade-pages.mjs']],
  fixtures: [['--experimental-strip-types', experiment + 'run.mjs']],
};
const [command = 'help', ...extra] = process.argv.slice(2);
if (['help', '--help', '-h'].includes(command)) {
  console.log(`Legend project commands (paths below assume the repository root):
  node scripts/legend.mjs dev          Start the local server
  node scripts/legend.mjs check        Typecheck and focused checks
  node scripts/legend.mjs build        Check and build; does not deploy
  node scripts/legend.mjs bench        Existing takeoff benchmark
  node scripts/legend.mjs trade-pages  Regenerate trade HTML
  node scripts/legend.mjs fixtures     Regenerate fixture/evaluation outputs`);
} else if (!Object.hasOwn(commands, command) || extra.length) {
  console.error('Unknown command or unexpected arguments. Run with --help.');
  process.exitCode = 2;
} else if (!existsSync(resolve(root, 'node_modules/typescript/bin/tsc')) ||
           !existsSync(resolve(root, 'node_modules/vite/bin/vite.js'))) {
  console.error(`Dependencies are missing. Run npm ci in ${root}`);
  process.exitCode = 1;
} else {
  for (const args of commands[command]) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (result.error) {
      console.error(result.error.message);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
