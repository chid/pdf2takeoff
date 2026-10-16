#!/usr/bin/env node
// Fetch the public council drawing sets listed in test/council/manifest.json
// into test/council/cache/ (gitignored) for the local real-drawing suite.
//
//   node scripts/fetch-council.mjs                 # fetch anything missing
//   node scripts/fetch-council.mjs add <id> <url>  # download + append a manifest entry
//
// The drawings are copyright of their authors: councils publish them for
// public exhibition, not redistribution. They are cached locally for testing
// only and must never be committed. Exhibition copies are usually taken down
// once the period closes, so the cache — not the URL — is the durable copy;
// keep it backed up if you rely on a set.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'test', 'council', 'manifest.json');
const cacheDir = join(root, 'test', 'council', 'cache');
const UA = 'pdf2takeoff-test-fetch (+https://github.com/ajflow/pdf2takeoff)';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isPdf = (buf) => buf.subarray(0, 5).toString('latin1') === '%PDF-';

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!isPdf(buf)) throw new Error('response is not a PDF');
  return buf;
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
mkdirSync(cacheDir, { recursive: true });
const [cmd, id, url] = process.argv.slice(2);

if (cmd === 'add') {
  if (!id || !url) throw new Error('usage: fetch-council.mjs add <id> <url>');
  if (manifest.sets.some((s) => s.id === id)) throw new Error(`"${id}" is already in the manifest`);
  const buf = await download(url);
  writeFileSync(join(cacheDir, `${id}.pdf`), buf);
  manifest.sets.push({
    id,
    council: '',
    application: '',
    url,
    sha256: sha256(buf),
    bytes: buf.length,
    retrieved: new Date().toISOString().slice(0, 10),
    pages: null, // filled in by the first test run's report; set it by hand
    notes: '',
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`added ${id} (${buf.length} bytes) — fill in council, application, pages and notes`);
} else if (cmd === undefined) {
  let failed = 0;
  for (const set of manifest.sets) {
    const file = join(cacheDir, `${set.id}.pdf`);
    if (existsSync(file)) {
      const ok = sha256(readFileSync(file)) === set.sha256;
      console.log(`${ok ? 'cached ' : 'CHANGED'} ${set.id}${ok ? '' : ' — cached bytes do not match the manifest sha256'}`);
      if (!ok) failed++;
      continue;
    }
    try {
      const buf = await download(set.url);
      const hash = sha256(buf);
      if (hash !== set.sha256) {
        // keep it aside: the council may have re-issued the set
        writeFileSync(`${file}.new`, buf);
        console.log(`CHANGED ${set.id} — upstream sha256 ${hash.slice(0, 12)}… differs; saved as ${set.id}.pdf.new`);
        failed++;
        continue;
      }
      writeFileSync(file, buf);
      console.log(`fetched ${set.id} (${buf.length} bytes)`);
    } catch (err) {
      console.log(`MISSING ${set.id} — ${err.message} (exhibition copies are often taken down; restore it from a backup)`);
      failed++;
    }
  }
  process.exitCode = failed ? 1 : 0;
} else {
  throw new Error(`unknown command "${cmd}" — run with no arguments, or "add <id> <url>"`);
}
