# ScaledDrawingBench v0.1

A public, deterministic benchmark for measuring quantities from a scaled
construction drawing: the drawing scale, wall lengths, room areas and
perimeters, symbol counts, printed dimensions, and what changed between two
revisions. Every sheet is generated from a seed, so every answer is exact,
and the vector half regenerates byte-for-byte from the generator in this
repository. The raster half is JPEG pixels rendered by pdf.js +
@napi-rs/canvas, which shift slightly across versions and platforms; the
manifest's `environment` stamp (node, pdfjs-dist, @napi-rs/canvas,
tesseract.js) records the stack a set was built with, and raster-half
scores are comparable only within the same stamp.

## Scope limits, honestly

- The generator deliberately draws inside the engine's design assumptions:
  symbols are filled connected components placed clear of walls and labels,
  and dimension text sits at the offsets the reference reader accepts. A
  perfect score here means the engine handles this distribution — stroked
  or wall-touching symbols, or dimension strings in unfamiliar positions,
  are out of scope for v0.1 and are exactly where a real sheet will differ.
- CI (`scripts/check-scaled-bench.mjs`) runs the reference solver on the
  committed sample and asserts the vector half scores 100 percent — the
  sample therefore cannot contain a vector case the engine fails; the full
  200-sheet set is where honest failures live.
- The reference solver is the engine itself reading its own generator's
  conventions; a third-party engine evaluated on this set should treat the
  answer key, not the reference's methods, as the contract.

The survey in [docs/research/benchmarks](../../docs/research/benchmarks/README.md)
found no public benchmark that asks for a length or an area measured off a
scaled drawing (DesignQA's 20 scale questions are the closest). This fills
that gap for the thing a takeoff tool is for.

- Code (generator, scorer, reference solver): Apache-2.0, like the rest of pdf2takeoff.
- Data (generated sheets, questions, answer key): CC BY 4.0. Attribution: "ScaledDrawingBench, pdf2takeoff contributors, https://github.com/ajflow/pdf2takeoff".

## What is in a set

`npm run bench:scaled -- generate` writes `bench/scaled-drawing-bench/v0.1/`
(gitignored; a 5-sheet sample is committed under `sample/`):

| File | Contents |
|---|---|
| `sheets/SDB-NNN.pdf` | one sheet per file, page 1; `SDB-NNN-revB.pdf` for sheets with a revision B |
| `questions.jsonl` | one question per line (schema below) |
| `answers.csv` | `id,sheet,page,type,answer,unit,tolerance` |
| `manifest.json` | version, seed, licence, conventions, per-sheet metadata (half, size, rotation, notation, ratio, units, recipe, revision B) |
| `report.md` | generation summary, including whether the raster half rendered back through the engine |

200 sheets by default (`--count`, `--seed 20261018`):

- **Vector half** (sheets 1 to 100): born-digital PDFs with a text layer and vector geometry.
- **Raster half** (sheets 101 to 200): the same kind of drawing rendered at 150 dpi through the Node raster adapter, degraded with one scan recipe per sheet (blur, speckle noise, contrast, 1 to 2 degree skew, photocopy) and re-embedded as a JPEG image PDF with no text layer.
- Sheet sizes A3, A1 and ARCH D; one sheet in five is rotated 90 degrees (page `/Rotate` on the vector half, a sideways scan on the raster half).
- Five scale notations, one per sheet: a ratio in the title block (`SCALE 1:100 @ A1`), imperial architectural (`1/4" = 1'-0"`), engineer's (`1" = 20'`), a graphic scale bar only, and printed dimensions only (no scale statement). Metric sheets are dimensioned in millimetres, imperial ones in feet and inches.
- A few sheets say `SCALE: NTS` and print no dimensions and no bar: their scale, length, area, perimeter and dimension questions are **unanswerable by design** (about 5 percent of all questions) and exist to measure hallucination.
- Each sheet: 3 to 9 rooms (some L-shaped) with printed names, walls drawn as filled rectangles (external 200 mm or 6 in, partitions 100 mm or 4 in), door openings (plain gaps, no leaf), 5 to 40 repeated symbols from five classes (downlight, GPO, switch, smoke detector, diffuser) at paper size with a legend, dimension strings along the south and west sides, a title block and a north arrow.
- One sheet in ten has a revision B with a known change set drawn from: a partition wall moved (which also changes the printed dimensions), a door added, a symbol removed.

Conventions, stated in every question: room areas and perimeters are between
the inside faces of the walls; external wall lengths are along the outside
face; partition lengths are centreline, between the centrelines of the
external walls, door openings included; the legend symbol is not counted.

## Question schema

```json
{
  "id": "SDB-003-q04",
  "sheet": "SDB-003",
  "page": 1,
  "type": "area",
  "question": "What is the floor area of BED 2 on sheet SDB-003, in square metres, measured between the inside faces of its walls?",
  "answer": 10.98,
  "unit": "m2",
  "tolerance": 0.02,
  "provenance": { "room": "BED 2", "shape": "L", "polygonU": [[0, 0], [4.2, 0], ...], "labelAtU": [2.1, 1.3] }
}
```

Types and answers:

| type | answer | unit | scored by |
|---|---|---|---|
| `scale` | the N of 1:N (48 for 1/4" = 1'-0") | `ratio` | within 2 and 5 percent |
| `length` | number | `m` or `ft` | within 2 and 5 percent, MAPE |
| `area` | number | `m2` or `ft2` | within 2 and 5 percent, MAPE |
| `perimeter` | number | `m` or `ft` | within 2 and 5 percent, MAPE |
| `count` | integer | `count` | exact match |
| `dimension_read` | the printed value (mm, or decimal feet) | `mm` or `ft` | within 2 and 5 percent (tolerance 0.5 percent for rounding) |
| `compare` | list of change items: `wall moved`, `door added`, `dimension changed`, `<symbol> removed` | `set` | set F1 |

Unanswerable questions carry `"answer": "unanswerable"`. `provenance` records
what the generator placed (polygons and label points in model units, symbol
centres, the printed text) so a disputed answer can be checked; solvers must
not read it.

## Running it

```bash
npm run bench:scaled -- generate                        # 200 sheets, seed 20261018, into bench/scaled-drawing-bench/v0.1
npm run bench:scaled -- generate --count 5 --seed 12 --out bench/scaled-drawing-bench/sample
npm run bench:scaled -- reference --set bench/scaled-drawing-bench/v0.1   # pdf2takeoff's deterministic solver, then score
npm run bench:scaled -- score --set bench/scaled-drawing-bench/v0.1 --predictions preds.jsonl --out results/my-system
```

Predictions are JSONL, one line per question: `{"id": "SDB-003-q04", "answer": 10.9}`.
Numbers are in the question's unit; compare answers are a list of strings;
`"unanswerable"` or `null` abstains. Extra fields (notes, provenance) are
ignored. The scorer writes a markdown table and a JSON file with per-type,
per-half, per-notation and per-recipe aggregates plus every judged row.

## Metrics

- **Within 2 percent / within 5 percent**: share of answerable numeric questions whose answer is within that relative error of the key. An abstention counts as wrong.
- **MAPE** and median APE over the answered numeric questions.
- **Exact**: count questions answered with exactly the key.
- **Set F1**: compare questions, precision and recall over the change items.
- **Accuracy**: within 2 percent for numeric types, exact for counts, exact change set for compare; the headline per type and overall.
- **Hallucination rate**: numeric or list answers given to questions that are unanswerable by design, over the number of such questions. A fabricated number is reported here rather than folded into accuracy.

The reference run reports the vector and raster halves separately, as the
benchmark intends: the raster half is where drawing-reading systems differ.

## Submitting results

Open a pull request adding `bench/scaled-drawing-bench/results/<system>.md`
(the scorer's markdown output) and `<system>.jsonl` (the predictions), with a
short note on what the system is (model, tools, prompt or pipeline) and the
set version and seed it ran on. Runs must use the unmodified generator at the
stated seed; the questions file is deterministic, so the sheet ids line up.
Model-based systems should also state whether they saw the provenance field
(they must not) and whether any human corrections were made (they must not).

## pdf2takeoff reference (deterministic, no model)

`reference` answers every question with the engine and nothing else:

- scale: `findScaleRatio` over the text layer (vector) or tesseract.js OCR words (raster); failing that, the graphic scale bar (numbered ticks measured against their paper distance) or printed dimensions measured against their drawn dimension line, combined with `scale.ts` dimension votes and consensus;
- area and perimeter: Dynamic Fill from a click beside the room label, with the label, scale and vector doorway-bridge hints the app passes;
- length: filled wall rectangles from the vector layer; on rasters, ink runs on the page (the automated equivalent of clicking the two ends of a wall);
- count: one click on the legend symbol through the scan tiers (vector match on born-digital sheets, tier-1 CV on rasters), legend instance excluded, hits inside the filled room for per-room counts;
- dimension_read: the printed value nearest the named side of the filled room;
- compare: `ops.compareDocs` plus `revdiff.ts` vector and text diffs on vector pairs; pixel diff, re-scans and OCR on raster pairs.

Anything the solver cannot derive is answered `unanswerable`. Raster sheets
run in a child process each; while the engine's image-PDF render crashes
(WP1), the child decodes the embedded image directly into the same raster
layout and says so in the notes.

Reference run on v0.1 (seed 20261018, 200 sheets, 2,040 questions, 1,929 s on one core; full output in [results/pdf2takeoff-reference.md](results/pdf2takeoff-reference.md), predictions in `results/pdf2takeoff-reference.jsonl`):

Vector half (100 sheets, 980 answerable questions, 37 unanswerable by design):

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 95 | 95 | 100% | 100% | 0% | n/a | n/a | 100% | 0/5 |
| length | 190 | 190 | 100% | 100% | 0% | n/a | n/a | 100% | 0/10 |
| area | 234 | 234 | 100% | 100% | 0.7% | n/a | n/a | 100% | 0/12 |
| perimeter | 95 | 95 | 100% | 100% | 0.3% | n/a | n/a | 100% | 0/5 |
| count | 263 | 261 | n/a | n/a | 0% | 99.2% | n/a | 99.2% | n/a |
| dimension_read | 95 | 95 | 100% | 100% | 0% | n/a | n/a | 100% | 0/5 |
| compare | 8 | 8 | n/a | n/a | n/a | n/a | 100% | 100% | n/a |
| all | 980 | 978 | 100% | 100% | 0.2% | 99.2% | 100% | 99.8% | 0/37 |

Raster half (100 sheets, 968 answerable, 55 unanswerable by design; pixels decoded directly from the image PDFs because the engine's image render crashed, see the notes in the results file):

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 93 | 38 | 34.4% | 34.4% | 36.7% | n/a | n/a | 34.4% | 0/7 |
| length | 186 | 52 | 17.2% | 17.2% | 19.8% | n/a | n/a | 17.2% | 0/14 |
| area | 235 | 71 | 26.4% | 27.7% | 278.5% | n/a | n/a | 26.4% | 0/20 |
| perimeter | 93 | 28 | 26.9% | 26.9% | 33% | n/a | n/a | 26.9% | 0/7 |
| count | 256 | 121 | n/a | n/a | 99.9% | 0% | n/a | 0% | n/a |
| dimension_read | 93 | 14 | 9.7% | 9.7% | 65.8% | n/a | n/a | 9.7% | 0/7 |
| compare | 12 | 12 | n/a | n/a | n/a | n/a | 37.7% | 0% | n/a |
| all | 968 | 336 | 22.9% | 23.3% | 111.5% | 0% | 37.7% | 16.5% | 0/55 |

Raster half by degradation recipe (accuracy): photocopy 25.4%, contrast 25.9%, noise 14.2%, rotate (1 to 2 degree skew) 12.3%, blur 7.7%. The vector half's two misses are per-room counts on NTS sheets: without a scale the fill cannot size the doorway and leaks, so the room polygon is never formed.

Reading the table: the vector half is the engine's home ground (text layer,
exact geometry, vector symbol matching). The raster half shows the real
limits of the current raster path, in order of damage:

- **Counts, 0 percent.** The tier-1 CV scan matches components by a 20 x 20 coverage signature with an L1 tolerance of 0.16, which only pixel-identical components pass; anti-aliased instances of the same 9 pt symbol at different sub-pixel offsets differ by more than that, so a legend click finds 1 to 3 of 8 to 21 instances even on a clean render. The ONNX detector tier is not reachable headless (ops.ts never calls it).
- **Scale, 34 percent.** OCR (tesseract.js, as in the browser) reads ratio and imperial title-block notes on most sheets, but 7 pt scale-bar labels and dimension strings vanish under blur and speckle, so bar-only and dimension-only raster sheets mostly abstain. Every failure is an abstention, never a wrong ratio.
- **Lengths, 17 percent, and areas, 26 percent.** Mostly downstream of a missing scale; skewed scans also defeat the row and column ink-run wall finder, and speckle breaks Dynamic Fill's wall closing.
- **Printed dimensions, 10 percent.** Small text under degradation, and west-side (vertical) text, which OCR does not read.
- **Compare, F1 38 percent.** Pixel diffs between two independently degraded scans are mostly noise; symbol removals are still caught through re-scans.

Each of those is a patch target, and this table is how to tell when it lands.

## Versioning

`v0.1` is the first release: seed 20261018, 200 sheets. A change to the
generator that alters any sheet or question bumps the version; results are
only comparable within a version.

The v0.1 generator freezes its historical random ordering in
`scripts/bench/shuffle-v01.mjs`. Native `Array.sort` with a random comparator
changed the random-stream consumption across runtimes. The fixed ordering
reproduces the committed seed-12 sample questions exactly; no benchmark
questions, answer keys or scorers are replaced by this compatibility fix.
