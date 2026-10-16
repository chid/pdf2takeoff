// Headless CLI against drawings shaped like real ones. Each case runs the CLI
// in a child process so a native crash fails the test instead of the runner.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, rgb } from 'pdf-lib';

const CLI = join(import.meta.dirname, '..', 'bin', 'pdf2takeoff.js');

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

/** An A3 sheet with three identical square symbols and a raster logo in the
 *  title block — the image is what used to crash the Node renderer. */
async function sheetWithLogo(): Promise<string> {
  const logo = createCanvas(120, 40);
  const ctx = logo.getContext('2d');
  ctx.fillStyle = '#336699';
  ctx.fillRect(0, 0, 120, 40);
  const doc = await PDFDocument.create();
  const page = doc.addPage([1191, 842]);
  page.drawImage(await doc.embedPng(logo.toBuffer('image/png')), { x: 1000, y: 40, width: 120, height: 40 });
  for (const x of [200, 400, 600]) {
    page.drawRectangle({ x, y: 400, width: 20, height: 20, borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
  }
  const file = join(mkdtempSync(join(tmpdir(), 'p2t-')), 'logo-sheet.pdf');
  writeFileSync(file, await doc.save());
  return file;
}

test('scan renders a sheet with an embedded image without crashing', async () => {
  const r = cli('scan', await sheetWithLogo(), '--page', '1', '--at', '200,410');
  assert.equal(r.signal, null, `CLI crashed: ${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).count, 3);
});
