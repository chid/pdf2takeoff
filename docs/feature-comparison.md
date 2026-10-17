# Feature comparison: pdf2takeoff vs Bluebeam Revu

Living document — update when features ship or Bluebeam's lineup changes.
Last verified against **bluebeam.com/au/pricing** on **2026-10-16**; updated 2026-10-16 after the measurement-completeness release.

Purpose: (1) honest public comparison for users evaluating a free alternative,
(2) internal roadmap tracker showing exactly which Bluebeam capabilities we
have, are building, or are deliberately skipping.

> Bluebeam, Revu, Studio, Tool Chest, Dynamic Fill, Quantity Link, VisualSearch,
> Smart Review and Batch Slip Sheet are trademarks of Bluebeam, Inc. Feature
> names are used nominatively for comparison only. Our implementations are
> independent and open source (Apache-2.0).

## Price context

| | Bluebeam | pdf2takeoff |
|---|---|---|
| Basics | AU$451 /user/yr | — |
| Core | AU$550 /user/yr | — |
| Complete | AU$737 /user/yr | — |
| Max (early 2026) | AU$979 /user/yr | — |
| Any tier | — | **Free, no account** |

Bluebeam's full desktop app is Windows-only (web/mobile are companions).
pdf2takeoff runs in any modern browser on any OS.

## Legend

- ✅ **Shipped** — works today at pdf2takeoff.com
- ⭐ **Goes further** — shipped, and beats or has no equivalent at Bluebeam's price point
- 🔜 **Planned** — on the roadmap (see [specs/headless-engine.md](../specs/headless-engine.md) and the README roadmap)
- ➖ **Not planned** — deliberate non-goal (see [Why we don't build these](#why-we-dont-build-these))

## Measurement & takeoff

| Feature | Bluebeam tier | pdf2takeoff | Notes |
|---|---|---|---|
| Length (segmented runs) | Core | ✅ | Polylength equivalent; live totals, per-label grouping |
| Area | Core | ✅ | Polygon areas with live values |
| Count | Core | ✅ | Per-label group totals |
| Scale calibration | Basics | ✅ | Known dimension or presets (1:50–1:500, imperial); metric + imperial |
| Per-page scales | Core (viewports) | ✅ | Each sheet keeps its own scale; one-click apply-to-all |
| Perimeter | Core | ✅ | Closed-polygon boundary length; round-trips as a Polygon annotation |
| Volume | Core | ✅ | Area × depth with a depth prompt; depth stored in the annotation comment |
| Angle | Core | ✅ | 3-click angle at a vertex; scale-free — works before calibration |
| Multi-scale viewports on one page | Core | ✅ | Outline a detail region (W), pick its scale — measurements inside resolve automatically (verified: same 100 pt run = 1.76 m at 1:50 vs 3.53 m at 1:100) |
| Dynamic Fill (flood-fill areas) | Complete | ✅ | Click inside a room → area off the walls in ~150 ms; door-gap closing is the follow-up |
| Formulas & custom columns | Complete | ✅ | Safe formula columns (value/count vars) in totals + every export + MCP; waste, rates |

## Auto-count & symbol search

| Feature | Bluebeam tier | pdf2takeoff | Notes |
|---|---|---|---|
| Click-to-teach auto-count | — (nearest: VisualSearch) | ⭐ | ~100 ms local CV; no model download, nothing uploaded |
| Symbol search | Complete (VisualSearch) | ⭐ | Covered by Scan — and it counts, not just finds |
| ML symbol detection | — | 🔜 | In-browser ONNX; Kaggle training notebook ready |
| Whole-set symbol schedules | — | ✅ | `scan --all-pages` / MCP `all_pages`: teach the symbol on one sheet, count it on every sheet wherever it sits; per-page schedule in one call (vector or CV template today, classes when the model lands) |

## Markups, list & export

| Feature | Bluebeam tier | pdf2takeoff | Notes |
|---|---|---|---|
| Markups list | Basics | ✅ | Rename, regroup, jump to page, delete |
| Save markups into the PDF | Revu native | ✅ | Standard Line / PolyLine / Polygon / FreeText annotations (pdf-lib) |
| CSV export | Basics | ✅ | Plus clipboard copy |
| Printable quantity report | Complete (reporting) | ✅ | Marked-up sheets + per-sheet tables + group totals |
| Markup legend | Complete | ✅ | Group totals in report (visual legend later) |
| Round-trip with Revu & Acrobat | — | ⭐ | Interoperability is the design, not an afterthought |
| Excel workbook export | Complete (Quantity Link output) | ⭐ | One-click .xlsx; the live Excel link is desktop-only by nature |
| Filter & sort | Basics | ✅ | Search by label, status pills, sort by label/page |
| Custom statuses | Basics | ✅ | Flag / confirm cycle; rides in the PDF comment so it survives round-trips; agents can set it via MCP | |
| Saved tool presets | Basics (Tool Chest) | ✅ | Our name: tool library — chips apply type + label to every placement and scan hit; persist locally |
| Markup layers | Basics | ✅ | Place per trade, eye toggles hide canvas/table/totals; names ride in the PDF comment | |
| Note / callout tool | Basics | ✅ | Pin a note (T); round-trips through FreeText with counts disambiguated by ': 1' |

## Compare & revisions

| Feature | Bluebeam tier | pdf2takeoff | Notes |
|---|---|---|---|
| Overlay compare | Core | ✅ | Red = removed, blue = added, dark = unchanged |
| Changes-only fade | — | ✅ | Greys everything unchanged |
| Alignment nudge & auto-fit | Complete (Auto-Align) | ✅ | 1 pt nudge + fit; full auto-align planned |
| Batch compare across sets | Complete | ✅ | CLI + MCP: two folders, sheets paired by filename, added/removed listed, per-pair overlays (interactive UI compare stays single-sheet for now) |
| Quantity diff between revisions | — (none) | ✅ | `run takeoff.yaml --prev` — regenerate on a new revision and diff quantities; nobody in this space ships it |
| Sets / slip-sheeting | Revu Sets | ✅ | CLI `set`: walk a folder, newest file per sheet name, merge into one sorted current-issue PDF |

## Document management

| Feature | Bluebeam tier | pdf2takeoff | Notes |
|---|---|---|---|
| Combine & split PDFs | Basics | 🔜 | pdf-lib |
| Rotate / extract pages | Basics | 🔜 | |
| OCR | Complete | ✅ | Tesseract.js: reads the printed dimension you clicked or the title-block scale ("1:100") straight into the calibration |
| Bookmarks & TOC | Basics | ➖ | Low takeoff value |
| Headers, footers, page labels | Basics | ➖ | |

## Collaboration & access

| Feature | Bluebeam tier | pdf2takeoff | Notes |
|---|---|---|---|
| Runs in any browser, any OS | Companion web tier | ⭐ | Revu desktop is Windows-only |
| Offline use | Mobile tier | ⭐ | Works offline once loaded; drawings never leave the machine |
| Real-time multi-user sessions | Core (Studio Sessions) | ✅ | Same-machine live sync (Live toggle): placements, edits, deletions, calibrations, presence all sync both ways; cross-machine relay is next |
| Mobile app | — | ➖ | The browser app serves tablets |
| Cloud project hosting | Core (Studio Projects) | ➖ | Local-first by design |

## AI & agents

| Feature | Bluebeam tier | pdf2takeoff | Notes |
|---|---|---|---|
| Private, no-upload AI | — | ⭐ | Nothing uploads — ever; Bluebeam's Max AI is cloud-connected |
| Agent API (MCP) | Max (AU$979) | 🔜 | Headless H3 — free, local, open source |
| Cross-platform CLI & scripting | Complete (Windows scripting) | 🔜 | Headless H2 — Node CLI, runs anywhere |
| Takeoff-as-code in CI | — | ✅ | Committed `takeoff.yaml` + `run` regenerate quantities per revision; CI-smoked |
| Cloud AI drawing review | Max (Smart Review) | ➖ | Data-loop first; revisit once the model ships |

## Platform & integrations

| Feature | Bluebeam tier | pdf2takeoff | Notes |
|---|---|---|---|
| Windows desktop app | All tiers | ➖ | Browser instead — any OS |
| CAD plugins (AutoCAD, Revit, Navisworks, SolidWorks) | Core | ➖ | Desktop-only; DXF import is a possible later step |
| DMS integrations (SharePoint, Procore, Box…) | Web tiers | ➖ | Local files by design; Bluebeam markups CSV import is on the roadmap |
| 3D PDF / IFC viewing | Core | ➖ | |
| Digital signatures & seals | Complete | ➖ | |
| PDF creation from Office/CAD | Basics | ➖ | |

## Scorecard

| | Count |
|---|---|
| ✅ Shipped today | 31 |
| ⭐ Shipped and goes further | 7 |
| 🔜 Planned | 5 |
| ➖ Deliberately not built | 11 |

## Where we go further (summary)

1. **Scan** — click one symbol, count them all, locally, in ~100 ms. No
   equivalent at any Bluebeam tier for the click-to-teach workflow.
2. **Privacy** — 100% client-side, zero upload, works offline. Bluebeam's AI
   and collaboration features are cloud-connected.
3. **Price & platform** — free, no account, any OS with a browser.
4. **Open source** — Apache-2.0; fork it, embed it, self-host it.
5. **Agent-native (roadmap)** — CLI + MCP + takeoff-as-code. Bluebeam puts MCP
   behind its AU$979 Max tier; our engine exposes it free.

## Why we don't build these

STRATEGY.md's principle: we own the estimator's hour, not all of PDF
engineering. Specifically:

- **Desktop/CAD plugins** — impossible in a browser and 20 years of catch-up;
  our interop story (standard annotations) already covers the workflow.
- **Cloud collaboration hosting** — contradicts local-first, which is the
  privacy moat. Live sessions (phase 4) are p2p-first for the same reason.
- **Signatures, redaction, forms, TOC** — document-control workflows, not
   takeoff; low value per engineering hour.
- **Cloud AI review** — revisit after the data loop ships; privacy-first AI is
  the differentiator, not another cloud model.
