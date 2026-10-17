# Spec: Headless Engine & Agent API

| | |
|---|---|
| **ID** | HEADLESS-1 |
| **Status** | Draft for review |
| **Date** | 2026-10-16 |
| **Phase alignment** | Slots in as Phase 3.5 (after the ML scan seam, before/alongside live sessions); H4 depends on the ONNX model shipping |
| **Repo safety** | Public-safe: no client names, no revenue detail. Can be committed to `main`. |

---

## 1. Summary

Extract pdf2takeoff's measurement, scan, compare and export logic from the
browser app into a **framework-agnostic engine**, then expose that engine
through three headless surfaces:

1. a **Node CLI** (`pdf2takeoff …`) for scripts, batch jobs and pipelines,
2. an **MCP server** (`pdf2takeoff mcp`) so AI agents can drive a full takeoff,
3. a **declarative takeoff spec** + `run` command ("takeoff-as-code") so a
   committed file regenerates quantities whenever drawings change.

The interactive web app keeps working exactly as it does today — it becomes
the first consumer of the engine, not the owner of the logic.

---

## 2. Why

### 2.1 The problem

Today every pdf2takeoff capability requires a human with a mouse: open the
viewer, click, measure, export. That covers the interactive hour, but not the
work around it:

- Estimators re-count the *same symbols* on *every revision* of a recurring
  tender (weekly retail rollouts, volume builders, FM contract renewals).
- PMs want quantities **diffed between revisions** ("what changed since R2?")
  without opening a viewer at all.
- The emerging workflow driver is an **AI agent** (Claude, Cursor, ZCode,
  custom internal bots). Agents today can read a PDF's text but cannot measure,
  count symbols, or produce a quantity schedule — because no takeoff engine
  speaks their language.

### 2.2 The market signal

Bluebeam's new top tier (**Max, AU$979/user/yr**, launching early 2026) is
built around *"AI integration via MCP"* plus AI drawing review. That is
Bluebeam putting agent integration at the **top of their pricing ladder**.

An Apache-2.0 engine with a first-class MCP surface open-sources exactly that
tier's differentiator. This is the same move as the rest of the product: free
where Bluebeam charges, local where cloud tools upload.

### 2.3 Why it compounds our moats (per STRATEGY.md §1)

| Moat | How headless strengthens it |
|---|---|
| **Data loop** | Every agent-proposed count that a human confirms is a training label. Agent-driven runs are the cheapest label source we will ever have — the agent does the proposal, the human one click of confirmation. |
| **Community** | CLI + MCP make pdf2takeoff embeddable in other people's pipelines (estimating suites, Procore exports, internal bots). Contributions stop being "PRs to a web app" and become "adapters on an engine." |
| **Brand** | "AI-native takeoff" stops being a claim about one scan button and becomes the architecture: the only open takeoff engine an agent can drive end-to-end. |

### 2.4 Why architecturally (one engine, every feature lands twice)

Without an engine split, every future feature (perimeter/volume/angle, tool
library, batch compare) gets built for the browser and then — never — for
scripts. With the split, each feature lands in the engine once and arrives
simultaneously in the web UI, the CLI, and the MCP API. The split also kills
Node/browser drift: one code path, two runtimes behind small ports
(canvas rasterizer, storage).

---

## 3. What it enables

### 3.1 Estimator (human, interactive) — nothing lost, some gained

The web app is unchanged. Gains from the engine existing:

- Batch operations become possible in the app later (compare 40 sheets, not 1)
  because the logic no longer assumes a single visible page.
- Annotations written by an agent overnight open in the web app for review,
  because everything is still standard PDF annotations.

### 3.2 Technical estimator / PM (scripted, no AI required)

```bash
# What changed between tender R2 and R3, without opening anything?
pdf2takeoff compare r2.pdf r3.pdf --json | jq '.sheets[].changed_percent'

# Recount the symbols on the new revision, regenerate the workbook
pdf2takeoff run takeoff.yaml          # reads r3.pdf, writes quantities.xlsx + marked-up PDF
```

Scenario — *recurring tender*: commit `takeoff.yaml` next to the drawing set
in a project repo. Every revision drop, CI (or a pre-commit hook, or a folder
watcher) re-runs the spec and produces: updated quantities workbook,
marked-up PDF for review, and a **quantity diff** (what moved since last
revision). Bluebeam's scripting alternative is Windows-desktop-only; nobody in
this space ships revision-triggered takeoff regeneration in CI.

### 3.3 AI agent (MCP-driven, human-verifiable)

An agent with the pdf2takeoff MCP server can run the whole loop itself:

1. `open_document` → pages, sizes, existing annotations
2. `render_page` → **the agent's eyes**: a PNG of the sheet
3. `set_scale` → from the printed dimension it can see, or a known ratio
4. `scan_symbol` (click-point now, class name once the ONNX model ships)
   → found instances with coordinates
5. `measure` length/area → values in real units
6. `export` → CSV/XLSX; `save_annotated` → PDF with standard annotations
7. **Human verifies in the web app** — one glance, because round-trip
   annotations already work

Scenario — *"count every downlight on E-01 and give me a schedule"*: the
estimator says this in plain language to their agent; thirty seconds later
they have `downlights.xlsx` and a marked-up PDF they can trust because every
markup is visible and editable in the viewer they already know. The agent
never uploads the drawing anywhere (see §8).

### 3.4 What each surface is for

| Surface | Primary user | Best at |
|---|---|---|
| Web app | Estimator | Interactive, visual, first-time use |
| CLI | Scripter / CI | Batch, diffs, regeneration, pipelines |
| MCP server | Agent (supervised by a human) | Exploratory takeoffs in natural language, ambiguous "figure out what's on this sheet" work |
| Spec file | Process owner | Deterministic, repeatable, auditable recurring takeoffs |

---

## 4. Architecture

### 4.1 Module split (target)

```
src/
  engine/               ← pure TypeScript, zero DOM imports, runs in browser + Node
    types.ts            Markup, Calibration, ScanResult, CompareResult …
    geometry.ts         measurement math (from state.ts)
    units.ts            scale presets, unit parsing/formatting
    scan-cv.ts          tier-1 CV (binarize, connected components, match)
    scan-onnx-core.ts   ONNX decode logic, runtime injected
    compare-core.ts     raster blend + region-diff math (from compare.ts)
    annotate.ts         markups → standard PDF annotations (pdf-lib)      (from pdfio.ts)
    read.ts             PDF → markups (annotation round-trip import)
    export.ts           CSV / XLSX serialization (from table.ts/report.ts)
    ports.ts            Raster, PdfRenderer, Detector, Store interfaces
  app/                  ← the current web app, imports engine/
    viewer.ts tools.ts render.ts table.ts report.ts pagestrip.ts
    persistence.ts demo.ts main.ts styles.css
  headless/             ← Node-only entrypoints (new)
    cli.ts              command parsing → engine calls
    mcp.ts              MCP server (stdio) → engine calls
    speccun.ts          takeoff.yaml loader + runner
```

### 4.2 Ports (the only environment seams)

| Port | Browser adapter | Node adapter |
|---|---|---|
| `Raster` (get ImageData, draw) | native `<canvas>` / OffscreenCanvas | `@napi-rs/canvas` |
| `PdfRenderer` (page → raster, text) | pdfjs-dist + Vite worker URL | pdfjs-dist **legacy** build, main thread |
| `Detector` | onnxruntime-web (WASM) | onnxruntime-node |
| `Store` (session autosave) | IndexedDB (persistence.ts) | filesystem / in-memory (CLI runs are stateless by default) |

Engine functions take their dependencies as arguments (e.g.
`cvScan(page: RenderedPage, at: Pt)` instead of calling `getPdfDoc()`).
The three current inversion points are `scan-cv.ts` and `pdfio.ts` importing
from `viewer.ts`, and `compare.ts` importing the Vite worker URL.

### 4.3 Coordinate convention (agent-critical)

All public engine/API coordinates are **page points, origin top-left, y-down**
— identical to the pixel space of `render_page` output, so an agent can click
what it sees without a transform. Conversion to PDF user space (origin
bottom-left) happens inside the engine. One paragraph, documented once, in
`engine/ports.ts` and repeated in MCP tool descriptions.

---

## 5. Surface A — CLI

`npx pdf2takeoff <command>`. Deterministic output, `--json` on everything,
non-zero exit on failure, nothing interactive.

| Command | Purpose | Key output |
|---|---|---|
| `info <pdf>` | pages, sizes, existing annotations, per-page calibration if present | JSON |
| `compare <a.pdf> <b.pdf> [--png out]` | per-sheet changed %, changed-region bboxes, list of added/removed sheets | JSON (+ optional diff image) |
| `scan <pdf> --page N --at x,y --label L [--model dir]` | click-point auto-count (CV now, ONNX when model dir present) | hits + count JSON |
| `export <pdf> [--csv\|--xlsx] [-o out]` | annotations/markups → quantities | file |
| `annotate <pdf> --spec takeoff.yaml -o out.pdf` | write spec-defined markups into the PDF | annotated PDF |
| `run <spec.yaml>` | end-to-end: calibrate → scan → export → annotate | all outputs + summary JSON |
| `mcp` | start the MCP server (§6) | stdio |

All file processing is local; the CLI makes no network calls (model files come
from a local path or are absent → CV fallback).

---

## 6. Surface B — MCP server

Transport: **stdio** (local process; works with Claude Desktop, ZCode, Cursor,
any MCP client). Package: `@modelcontextprotocol/sdk` (MIT).

| Tool | Input (essentials) | Output |
|---|---|---|
| `open_document` | `path` | doc id, page count, page sizes, existing annotation count |
| `render_page` | `doc, page, dpi?` | PNG content block + width/height/page-space note — **the agent's eyes** |
| `set_scale` | `doc, page, {ratio \| from_points + real_length}` | confirmation + effective metres/point |
| `measure` | `doc, page, type: length\|area\|count, points[], label?` | value (formatted + raw), markup id |
| `scan_symbol` | `doc, page, at: [x,y], label?` or `{class}` (ONNX) | hits with coordinates, count |
| `measure_runs` | `doc, page, at: [x,y], label?, gap?` | every run in the clicked line's style (colour, width, dash) as length markups, per-run and total metres |
| `legend_schedule` | `doc, page, all_pages?, add_markups?` | legend blocks found, per-symbol counts (legend sample excluded), line styles, unmatched rows with reasons |
| `compare_revisions` | `path_a, path_b` | changed sheets, changed regions, summary |
| `list_markups` / `delete_markup` | `doc` / `doc, id` | markups table / confirmation |
| `export` | `doc, format: csv\|xlsx, out_path` | written file path |
| `save_annotated` | `doc, out_path` | PDF with standard annotations |

Design rules:

- Tools are **small and composable**, mirroring the UI verbs — an agent can
  reproduce anything a human clicks.
- Every tool returns units and coordinate frame explicitly in its description.
- Write operations (`export`, `save_annotated`) write **only** to paths the
  caller provides; the server never uploads, never phones home.
- Human verification loop is built in: `save_annotated` output opens in the
  web app / Revu / Acrobat with every markup visible.

---

## 7. Surface C — Takeoff spec (H4, after ONNX model ships)

```yaml
# takeoff.yaml — commit next to the drawings
source: tender-r3.pdf
scales:
  - pages: all            # or [1, 2] or 3
    ratio: 1:100
counts:
  - label: Downlight
    class: downlight      # ONNX class (H4); before the model: `at: [x, y]`
    page: 4
  - label: GPO
    class: gpo
    pages: all
exports:
  - format: xlsx
    out: quantities.xlsx
  - format: annotated-pdf
    out: tender-r3-marked.pdf
```

`pdf2takeoff run takeoff.yaml` in CI; on a new revision, update `source` and
re-run → regenerated quantities + marked PDF + **quantity diff vs the previous
run** (diff artifact stored alongside). Open question (tracked, not blocking):
whether manual polyline/area points belong in the spec or stay
interactive/agent-only.

---

## 8. Privacy & security posture

Local-first extends to the agent — this is the differentiator vs Bluebeam Max
and every cloud AI takeoff:

- The MCP server is a **local stdio process**. Drawings are opened, rendered
  and measured on the user's machine; the model sees only what the local
  server sends it (page images the user's agent asked for).
- The CLI makes **zero network calls**.
- No accounts, no telemetry, unchanged from the web app's promises.
- Threat model note: an MCP client can already read files the user gives it;
  our server adds no privileged access — it only formalizes takeoff verbs.

---

## 9. Dependencies & licensing (Apache/MIT-only rule holds)

| Package | Purpose | Licence |
|---|---|---|
| pdfjs-dist (legacy build) | Node PDF rendering | Apache-2.0 |
| @napi-rs/canvas | Node rasterizer | MIT |
| onnxruntime-node | Node ONNX inference | MIT |
| @modelcontextprotocol/sdk | MCP server | MIT |
| pdf-lib / xlsx / pdfjs-dist | unchanged | MIT / Apache-2.0 / Apache-2.0 |

Explicitly **not** used: MuPDF (AGPL), Ultralytics (AGPL).

---

## 10. Non-goals

- **No hosted/remote API.** No server deployment, no auth, no accounts. If
  someone wants pdf2takeoff-as-a-service, they run the CLI in their own
  container — the licence already allows it.
- **No agent autonomy claims.** The product story is *agent proposes, human
  verifies* — annotations are always reviewable in standard viewers.
- **No new web-app features inside this spec** (perimeter/volume/angle, tool
  library, batch-compare UI are separate specs that *consume* the engine).
- **No Windows-native/desktop runtime** beyond what Node gives us.

---

## 11. Plan

| Phase | Work | Est. | Exit criteria |
|---|---|---|---|
| **H1 — Engine extraction** ✅ (2026-10-16) | `src/engine` + `src/app` split; Raster/Detector/ScanDeps ports; web app behavior identical | ~1 wk | ✅ Zero DOM/Vite imports under `engine/` (CI guard: `npm run typecheck:engine` = no-DOM-lib tsc + `scripts/check-engine.mjs`); ✅ engine type-checks standalone; ✅ build green; ✅ browser-verified: scan 8/8 in 192 ms, overlay compare red/blue, XLSX + annotated-PDF downloads, IndexedDB session restore |
| **H2 — Node CLI** ✅ (2026-10-16) | pdfjs legacy + napi-rs/canvas adapters; `info`, `compare`, `scan`, `export`, `annotate` (runs from source via Node ≥22.6 type stripping — no bundler) | ~1 wk | ✅ All commands verified on sample + 86-sheet soak; ✅ `compare --json` self-compare = 86/86 unchanged, 0 false positives (~93 ms/sheet), sample-vs-revB localizes the changed wall/door regions; ✅ scan 8/8 downlights, matching the browser exactly; ✅ golden raster: identical dimensions, mean Δ2.5/255, ~1.8% px >16/255 (glyph anti-aliasing only — see H2 notes); CI smokes `info` + `scan` |
| **H3 — MCP server** ✅ (2026-10-16) | stdio server with §6 tools; `pdf2takeoff mcp` (bin shim) — src/headless/mcp.ts over @modelcontextprotocol/sdk | ~1 wk | ✅ All 10 tools listed over the protocol; ✅ scripted end-to-end session (`scripts/mcp-smoke.mjs`, runs in CI): open → render (PNG + pt metadata) → set_scale → scan (8/8) → measure (11.995 m) → list/delete → export CSV → save_annotated → compare — 17/17 checks; ✅ annotated PDF round-trips (reopens with 9 annotations) — the human-review loop |
| **H4 — Spec runner + CI** ✅ model-independent half (2026-10-16) | `takeoff.yaml`, `run`, `--prev` quantity diff | ~1 wk | ✅ Sample: rev A → 8 downlights; swap in rev B, re-run with `--prev` → diff `8 → 5, delta −3`; csv/xlsx/annotated-pdf/summary exports; class-based counts activate automatically when the ONNX model lands (the `class:` field already parses) |

Sequencing notes:

- H1 **before** the measurement-completeness features (perimeter/volume/angle,
  tool library) so they are born dual-surface for free.
- H2/H3 can proceed while the Kaggle model trains; nothing blocks on it
  except class-based scan (H4).
- Total: ~4 weeks alongside ongoing Phase 2 hardening.

---

## 11b. H2 engineering notes (the gotchas, so nobody re-lives them)

Running pdf.js v5's legacy build on @napi-rs/canvas in Node:

1. **Path2D must be napi's, unconditionally.** pdf.js v5 draws through the
   global `Path2D`, and its legacy build installs its *own JS polyfill* on
   `globalThis` at import. skia's `ctx.fill(path)` only accepts its *native*
   `Path2D` class — rendering through pdf.js's polyfill **segfaults in native
   code** (SIGSEGV/SIGBUS, no stack). Fix: assign `globalThis.Path2D` /
   `ImageData` from `@napi-rs/canvas` **unconditionally** in
   `src/headless/raster-node.ts` — never "only if missing"; pdf.js defers to
   an existing global, so any module load order works.
2. **`standardFontDataUrl` must be a `file://` URL.** A bare filesystem path
   silently fails the standard-fonts load and the glyph fallback segfaults.
3. **Don't pass `canvas` to `page.render()`** — canvasContext + viewport only.
   The canvas param sends pdf.js down a bitmap-transfer path that also
   crashes native canvas.
4. **Golden raster (browser vs Node, same pdf.js 5.7, scale 3):** identical
   pixel dimensions; mean per-channel Δ 2.5/255; 1.8% of pixels exceed
   Δ16/255, concentrated on text glyph anti-aliasing (different skia builds).
   Functionally equivalent: the tier-1 scan returns identical results (8/8
   symbols) in both environments. Reproduce with `scripts/golden-raster.mjs`
   + the in-browser compare-canvas recipe.

H2 ships without the ONNX detector in Node (no model exists yet — training
is in flight); the `DetectorSession` port is ready for `onnxruntime-node`
the moment `symbols.onnx` lands (H4 prep).

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Node raster output differs subtly from browser (anti-aliasing, fonts) → scan/compare behave differently headless | Golden-image tests vs browser renders in H2; publish the tolerance; CV thresholds already normalized (`RASTER_SCALE`) |
| onnxruntime-node / web parity (input layout, output decode) | One decode implementation in `engine/scan-onnx-core.ts`, runtimes injected; unit test with the stub model used for the browser seam |
| Agents misuse/confuse coordinate frames | Top-left convention everywhere; width/height returned with every image; tool descriptions state the frame |
| Scope creep toward "hosted API product" | §10 non-goals; revisit only as an explicit strategy decision |
| MCP spec churn (protocol is young) | Pin SDK version; tools are thin wrappers — protocol churn can't reach the engine |
| Single-maintainer load (STRATEGY.md §9) | Each phase is independently shippable and useful; H1 alone pays for itself in code health |

---

## 13. Success metrics (measurable claims only)

- H1: engine module count and zero-DOM-import proof in CI (lint rule).
- H2: CLI works on the 86-sheet soak set; `compare --json` runtime per sheet
  published.
- H3: end-to-end agent session (open → export) completes in < 60 s on the
  sample; npx download counts as adoption signal.
- H4: one real recurring tender regenerated via spec across ≥ 2 revisions.
- Data loop (north star): confirmed agent-proposed counts become training
  labels via the existing confirmation flow — count them from Phase 5 onward.

---

## Appendix — open questions

1. Manual points in the spec file (§7): include, or keep spec to scales +
   class counts + exports? Default: keep spec minimal.
2. Should `compare` in the web app switch to the engine implementation in H1
   (recommended — one code path) or after H2?
3. MCP tool granularity: current table is verb-level; revisit if agent
  transcripts show repeated multi-call patterns worth wrapping.

## 14. Phase 4a status (live sessions, same-machine) — experimental

Shipped: Yjs CRDT over BroadcastChannel per file-hash channel. Verified
syncing both directions: placements, deletions, clear, calibrations,
presence + bye. RESOLVED: the JSON-leaf model + observeDeep fixed edit
propagation; final verification failed earlier only because the test
tabs were running stale HMR module generations. Verified clean both
directions: rename, status, drag-class edits, place, delete, clear,
calibration, presence. Remaining for 4b: Cloudflare Durable Object
relay for cross-machine sessions.
