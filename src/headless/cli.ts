// pdf2takeoff CLI — headless takeoff on Node. Local-only: no network calls,
// no telemetry. Deterministic JSON on stdout; errors on stderr with exit 1.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { openPdf } from './pdfjs-node.ts';
import { renderRasterNode } from './raster-node.ts';
import { scanDocAt, scanDocAllPages, compareDocs, compareFolders, runsDocAt } from './ops.ts';
import { basename, join } from 'node:path';
import { readPdfMarkups } from '../engine/read.ts';
import { buildAnnotatedPdf } from '../engine/annotate.ts';
import { buildMatrix, toDelimited, xlsxBytes, groupsOf } from '../engine/export.ts';
import { nextId, defaultLabel } from '../engine/geometry.ts';
import type { DisplayUnit } from '../engine/units.ts';
import type { Calibration, Markup } from '../engine/types.ts';
import { parseSpec, parseScaleSpec, parseRunSpec } from './spec.ts';
import { PDFDocument } from 'pdf-lib';

const HELP = `pdf2takeoff — free, open-source PDF takeoff (Apache-2.0)

Usage:
  pdf2takeoff info <file.pdf>
      Pages, page sizes, and annotation counts as JSON.
  pdf2takeoff set <folder> -o current-issue.pdf
      Slip-sheet: walk the folder, keep the newest file per sheet name
      (by modified time), merge into one sorted multi-sheet PDF.
  pdf2takeoff compare <a> <b> [--png out.png] [--png-dir dir] [--threshold 24]
      Two PDFs: per-sheet change fractions and changed regions.
      Two folders: batch compare — sheets paired by filename across the
      revision sets, with added/removed sheets listed. --png writes the
      overlay of the first changed sheet; --png-dir (folder mode) writes
      an overlay per changed pair.
  pdf2takeoff scan <file.pdf> --page N --at x,y [--all-pages]
      Click-point auto-count (tier-1 CV): every match on the page as JSON.
      --at is in PDF points; run "info" first to see page sizes.
      --all-pages scans every sheet and returns a per-page schedule.
  pdf2takeoff runs <file.pdf> --page N --at x,y [--scale 1:200] [--gap pt]
      Run lengths by line style: click one line (a dashed stormwater pipe,
      say) and get every run drawn the same way (colour, width, dash) on
      the page, as polylines with lengths in points, and in metres with
      --scale. --gap overrides the longest dash gap bridged.
  pdf2takeoff export <file.pdf> [--scale 1:100] [--unit m] [--format csv|tsv|xlsx] [-o out]
      Read pdf2takeoff annotations back out as a quantities table.
      csv/tsv print to stdout without -o; xlsx requires -o.
  pdf2takeoff annotate <file.pdf> --spec takeoff.yaml [-o out.pdf]
      Write spec-defined markups into the PDF as standard annotations.
  pdf2takeoff run <takeoff.yaml> [--prev previous-summary.json]
      Takeoff-as-code: calibrate, scan-count every symbol type in the spec,
      write the exports (csv / xlsx / annotated-pdf / summary JSON).
      --prev diffs quantities against a previous run — the revision loop.
  pdf2takeoff mcp
      Start the MCP server on stdio (for AI agents; see specs/headless-engine.md).

Everything runs locally; drawings never leave the machine.
`;

export { openPdf, renderRasterNode };

function readPdf(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

async function readMarkupsFromPdf(file: string): Promise<{ doc: Awaited<ReturnType<typeof openPdf>>; markups: Markup[] }> {
  const bytes = readPdf(file);
  return { doc: await openPdf(bytes), markups: await readPdfMarkups(bytes) };
}

async function cmdInfo(file: string): Promise<unknown> {
  const bytes = readPdf(file);
  const doc = await openPdf(bytes);
  const markups = await readPdfMarkups(bytes);
  let total = 0;
  const pages: { page: number; widthPt: number; heightPt: number }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    total += (await page.getAnnotations({ intent: 'display' })).length;
    pages.push({ page: p, widthPt: Math.round(vp.width), heightPt: Math.round(vp.height) });
  }
  return {
    file,
    pageCount: doc.numPages,
    pages,
    annotations: { pdf2takeoff: markups.length, other: Math.max(0, total - markups.length) },
  };
}

async function cmdScan(file: string, pageArg: string, atArg: string, allPages: boolean): Promise<unknown> {
  const page = parseInt(pageArg, 10);
  if (!Number.isInteger(page) || page < 1) throw new Error('--page must be a positive integer');
  const xy = atArg.split(',').map((v) => parseFloat(v));
  if (xy.length !== 2 || !xy.every((v) => Number.isFinite(v))) {
    throw new Error('--at must be "x,y" in PDF points');
  }
  const doc = await openPdf(readPdf(file));
  if (allPages) {
    const schedule = await scanDocAllPages(doc, { x: xy[0], y: xy[1] });
    return { file, ...schedule };
  }
  const result = await scanDocAt(doc, page, { x: xy[0], y: xy[1] });
  if ('error' in result) throw new Error(result.error);
  return {
    file,
    page,
    provider: result.provider,
    count: result.hits.length,
    hits: result.hits.map((h) => ({
      x: Math.round(h.x * 100) / 100,
      y: Math.round(h.y * 100) / 100,
      ...(h.label !== undefined ? { label: h.label } : {}),
    })),
  };
}

async function cmdRuns(file: string, pageArg: string, atArg: string, scale: string | undefined, gapArg: string | undefined): Promise<unknown> {
  const page = parseInt(pageArg, 10);
  if (!Number.isInteger(page) || page < 1) throw new Error('--page must be a positive integer');
  const xy = atArg.split(',').map((v) => parseFloat(v));
  if (xy.length !== 2 || !xy.every((v) => Number.isFinite(v))) {
    throw new Error('--at must be "x,y" in PDF points');
  }
  const gap = gapArg === undefined ? undefined : parseFloat(gapArg);
  if (gap !== undefined && !(gap >= 0)) throw new Error('--gap must be a length in PDF points');
  const metersPerPt = scale ? parseScaleSpec(scale) : undefined;
  const doc = await openPdf(readPdf(file));
  if (page > doc.numPages) throw new Error(`--page ${page}: the document has ${doc.numPages} pages`);
  const result = await runsDocAt(doc, page, { x: xy[0], y: xy[1] }, { metersPerPt, gap });
  if ('error' in result) throw new Error(result.error);
  return { file, page, scale: scale ?? null, ...result };
}

async function cmdCompare(fileA: string, fileB: string, png: string | undefined, pngDir: string | undefined, threshold: number): Promise<unknown> {
  // directory pair -> batch compare across the two revision folders
  const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  if (isDir(fileA) || isDir(fileB)) {
    if (!isDir(fileA) || !isDir(fileB)) {
      throw new Error('folder compare needs two directories (got one file, one folder)');
    }
    if (pngDir) mkdirSync(pngDir, { recursive: true });
    return await compareFolders(fileA, fileB, { pngDir, threshold });
  }
  const docA = await openPdf(readPdf(fileA));
  const docB = await openPdf(readPdf(fileB));
  const result = await compareDocs(docA, docB, { png, threshold });
  return {
    a: fileA,
    b: fileB,
    sheetCountA: docA.numPages,
    sheetCountB: docB.numPages,
    ...result,
  };
}

async function cmdExport(
  file: string,
  scale: string | undefined,
  unit: string,
  format: 'csv' | 'tsv' | 'xlsx',
  out: string | undefined,
): Promise<void> {
  const { doc, markups } = await readMarkupsFromPdf(file);
  if (markups.length === 0) {
    throw new Error(`no pdf2takeoff annotations found in ${file} (annotate it first, or open it in the web app)`);
  }
  const calibrations = new Map<number, Calibration>();
  if (scale) {
    const metersPerPt = parseScaleSpec(scale);
    for (let p = 1; p <= doc.numPages; p++) calibrations.set(p, { metersPerPt, source: `cli scale ${scale}` });
  } else {
    process.stderr.write('note: no --scale given; values will be blank until calibrated\n');
  }
  const matrix = buildMatrix({
    markups,
    calibrations,
    displayUnit: unit as DisplayUnit,
  });

  if (format === 'xlsx') {
    if (!out) throw new Error('--format xlsx requires -o <file.xlsx>');
    writeFileSync(out, xlsxBytes(matrix));
    process.stderr.write(`wrote ${out} (${markups.length} markups)\n`);
    return;
  }
  const text = toDelimited(matrix, format === 'csv' ? ',' : '\t');
  if (out) {
    // UTF-8 BOM so Excel opens the units correctly
    writeFileSync(out, '\ufeff' + text);
    process.stderr.write(`wrote ${out} (${markups.length} markups)\n`);
  } else {
    process.stdout.write(text + '\n');
  }
}

async function cmdAnnotate(file: string, specPath: string, outOverride: string | undefined): Promise<unknown> {
  const spec = parseSpec(readFileSync(specPath, 'utf8'), specPath);
  const output = outOverride ?? spec.output;
  if (!output) throw new Error('no output path: pass -o out.pdf or set "output" in the spec');

  const calibrations = new Map<number, Calibration>();
  if (spec.scale) {
    const metersPerPt = parseScaleSpec(spec.scale);
    const doc = await openPdf(readPdf(file));
    for (let p = 1; p <= doc.numPages; p++) calibrations.set(p, { metersPerPt, source: `spec scale ${spec.scale}` });
  }

  const markups: Markup[] = spec.markups.map((m) => ({
    id: nextId('cli'),
    page: m.page ?? 1,
    type: m.type,
    label: m.label ?? defaultLabel(m.type),
    points: m.points.map(([x, y]) => ({ x, y })),
    createdAt: Date.now(),
  }));

  const bytes = await buildAnnotatedPdf({
    bytes: readPdf(file),
    markups,
    calibrations,
    displayUnit: (spec.unit ?? 'm') as DisplayUnit,
  });
  writeFileSync(output, bytes);
  return { output, markups: markups.length, scale: spec.scale ?? null };
}

/** Execute a takeoff spec: calibrate, scan-count each symbol type, write exports. */
async function cmdRun(specPath: string, prevPath: string | undefined): Promise<unknown> {
  const spec = parseRunSpec(readFileSync(specPath, 'utf8'), specPath);
  const bytes = readPdf(spec.source);
  const doc = await openPdf(bytes);
  const calibrations = new Map<number, Calibration>();
  if (spec.scale) {
    const metersPerPt = parseScaleSpec(spec.scale);
    for (let p = 1; p <= doc.numPages; p++) calibrations.set(p, { metersPerPt, source: `spec scale ${spec.scale}` });
  }
  const markups: Markup[] = [];

  for (const c of spec.counts) {
    const page = c.page ?? 1;
    const result = await scanDocAt(doc, page, { x: c.at[0], y: c.at[1] });
    if ('error' in result) {
      throw new Error(`counts "${c.label}": ${result.error} (tune its at: point — run scan --json once to find the symbol)`);
    }
    if (result.hits.length === 0) throw new Error(`counts "${c.label}": the scan found no symbols`);
    for (const hit of result.hits) {
      markups.push({
        id: nextId('run'),
        page,
        type: 'count',
        label: c.label,
        points: [{ x: hit.x, y: hit.y }],
        createdAt: Date.now(),
      });
    }
  }

  const unit = (spec.unit ?? 'm') as DisplayUnit;
  const matrix = buildMatrix({ markups, calibrations, displayUnit: unit });
  const totals = groupsOf(markups).map((g) => ({
    label: g.label,
    type: g.type,
    items: g.items.length,
  }));

  const summary: Record<string, unknown> = {
    spec: specPath,
    source: spec.source,
    scale: spec.scale ?? null,
    ranAt: new Date().toISOString(),
    totals,
    counts: spec.counts.map((c) => ({
      label: c.label,
      page: c.page ?? 1,
      found: markups.filter((m) => m.label === c.label).length,
    })),
  };

  // --prev: quantity diff against a previous run's summary
  if (prevPath) {
    const prev = JSON.parse(readFileSync(prevPath, 'utf8')) as { totals?: { label: string; type: string; items: number }[] };
    const key = (x: { label: string; type: string }) => `${x.type}|${x.label}`;
    const prevMap = new Map((prev.totals ?? []).map((x) => [key(x), x.items]));
    const nowMap = new Map(totals.map((x) => [key(x), x.items]));
    const diff: { label: string; type: string; before: number | null; after: number | null; delta: number }[] = [];
    for (const k of new Set([...prevMap.keys(), ...nowMap.keys()])) {
      const before = prevMap.get(k) ?? null;
      const after = nowMap.get(k) ?? null;
      if (before === after) continue;
      const [type, label] = k.split('|');
      diff.push({ label, type, before, after, delta: (after ?? 0) - (before ?? 0) });
    }
    diff.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    summary.diff = diff;
  }

  for (const e of spec.exports) {
    if (e.format === 'csv') writeFileSync(e.out, '\ufeff' + toDelimited(matrix, ','));
    else if (e.format === 'xlsx') writeFileSync(e.out, xlsxBytes(matrix));
    else if (e.format === 'annotated-pdf') {
      writeFileSync(e.out, await buildAnnotatedPdf({ bytes, markups, calibrations, displayUnit: unit }));
    } else if (e.format === 'summary') {
      writeFileSync(e.out, JSON.stringify(summary, null, 2) + '\n');
    }
  }

  return summary;
}

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      process.stdout.write(HELP);
      return;
    }
    if (cmd === 'info') {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      if (positionals.length !== 1) throw new Error('usage: pdf2takeoff info <file.pdf>');
      process.stdout.write(JSON.stringify(await cmdInfo(positionals[0]), null, 2) + '\n');
      return;
    }
    if (cmd === 'scan') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { page: { type: 'string', default: '1' }, at: { type: 'string' }, 'all-pages': { type: 'boolean', default: false } },
      });
      if (positionals.length !== 1 || !values.at) throw new Error('usage: pdf2takeoff scan <file.pdf> --page N --at x,y [--all-pages]');
      process.stdout.write(JSON.stringify(await cmdScan(positionals[0], values.page, values.at, values['all-pages']), null, 2) + '\n');
      return;
    }
    if (cmd === 'runs') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { page: { type: 'string', default: '1' }, at: { type: 'string' }, scale: { type: 'string' }, gap: { type: 'string' } },
      });
      if (positionals.length !== 1 || !values.at) throw new Error('usage: pdf2takeoff runs <file.pdf> --page N --at x,y [--scale 1:200] [--gap pt]');
      process.stdout.write(JSON.stringify(await cmdRuns(positionals[0], values.page, values.at, values.scale, values.gap), null, 2) + '\n');
      return;
    }
    if (cmd === 'compare') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { png: { type: 'string' }, 'png-dir': { type: 'string' }, threshold: { type: 'string', default: '24' } },
      });
      if (positionals.length !== 2) throw new Error('usage: pdf2takeoff compare <a> <b> (files or folders) [--png out.png] [--png-dir out/]');
      const threshold = parseFloat(values.threshold);
      if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 255) throw new Error('--threshold must be 1..255');
      process.stdout.write(
        JSON.stringify(await cmdCompare(positionals[0], positionals[1], values.png, values['png-dir'], threshold), null, 2) + '\n',
      );
      return;
    }
    if (cmd === 'export') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          scale: { type: 'string' },
          unit: { type: 'string', default: 'm' },
          format: { type: 'string', default: 'csv' },
          o: { type: 'string' },
        },
      });
      if (positionals.length !== 1) throw new Error('usage: pdf2takeoff export <file.pdf> [--scale 1:100] [--format csv|tsv|xlsx] [-o out]');
      if (!['csv', 'tsv', 'xlsx'].includes(values.format)) throw new Error('--format must be csv, tsv or xlsx');
      await cmdExport(positionals[0], values.scale, values.unit, values.format as 'csv' | 'tsv' | 'xlsx', values.o);
      return;
    }
    if (cmd === 'annotate') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { spec: { type: 'string' }, o: { type: 'string' } },
      });
      if (positionals.length !== 1 || !values.spec) throw new Error('usage: pdf2takeoff annotate <file.pdf> --spec takeoff.yaml [-o out.pdf]');
      process.stdout.write(JSON.stringify(await cmdAnnotate(positionals[0], values.spec, values.o), null, 2) + '\n');
      return;
    }
    if (cmd === 'set') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { o: { type: 'string' } },
      });
      if (positionals.length !== 1 || !values.o) throw new Error('usage: pdf2takeoff set <folder> -o current-issue.pdf');
      process.stdout.write(JSON.stringify(await cmdSet(positionals[0], values.o), null, 2) + '\n');
      return;
    }
    if (cmd === 'run') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { prev: { type: 'string' } },
      });
      if (positionals.length !== 1) throw new Error('usage: pdf2takeoff run <takeoff.yaml> [--prev previous-summary.json]');
      process.stdout.write(JSON.stringify(await cmdRun(positionals[0], values.prev), null, 2) + '\n');
      return;
    }
    if (cmd === 'mcp') {
      const { runMcpServer } = await import('./mcp.ts');
      await runMcpServer();
      return;
    }
    throw new Error(`unknown command "${cmd}" — run "pdf2takeoff help"`);
  } catch (err) {
    process.stderr.write(`pdf2takeoff: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

/** Slip-sheet a folder of per-sheet PDFs into one current-issue set:
 *  sheets pair by filename, the newest file (mtime) wins, output is sorted. */
async function cmdSet(dir: string, out: string): Promise<unknown> {
  const byBase = new Map<string, { file: string; mtime: number }>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.pdf')) {
        const mtime = statSync(full).mtimeMs;
        const key = basename(entry.name);
        const prev = byBase.get(key);
        if (!prev || mtime > prev.mtime) byBase.set(key, { file: full, mtime });
      }
    }
  };
  walk(dir);
  if (byBase.size === 0) throw new Error(`no PDFs found under ${dir}`);
  const merged = await PDFDocument.create();
  merged.setProducer('pdf2takeoff 0.1.0');
  const sheets: { sheet: string; from: string; superseded: number }[] = [];
  for (const sheet of [...byBase.keys()].sort()) {
    const { file } = byBase.get(sheet)!;
    const src = await PDFDocument.load(readFileSync(file));
    const count = await merged.copyPages(src, src.getPageIndices());
    for (const page of count) merged.addPage(page);
    // count how many files shared this sheet name (superseded = losers)
    let dupes = 0;
    const recount = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) recount(full);
        else if (basename(entry.name) === sheet && full !== file) dupes++;
      }
    };
    recount(dir);
    sheets.push({ sheet, from: file, superseded: dupes });
  }
  writeFileSync(out, await merged.save());
  return {
    dir,
    output: out,
    sheets: sheets.length,
    supersededFiles: sheets.reduce((s, x) => s + x.superseded, 0),
    sheetsDetail: sheets,
  };
}

// direct invocation (node --experimental-strip-types src/headless/cli.ts …)
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2));
}
