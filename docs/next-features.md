# Next features

Suggestions from running the engine on real council drawing sets
(`test/council/`) and building the vector scan tier. Ranked by value to an
estimator for the effort, with what each would reuse.

## 1. Teach once, count every sheet

`scan --all-pages` (and MCP `scan_symbol` with `all_pages`) reuses the click
**coordinates** on every page, so on sheet 2 it counts whatever happens to sit
at that point, not the symbol taught on sheet 1. A real takeoff counts one
fitting type across 10–40 sheets.

Build: let `vectorScan` return the taught template (seed path + ink cover)
and add `matchTemplate(page, template)`; `--all-pages` teaches on `--page`
and matches the template everywhere. The raster tier can do the same with
its component signature. Test: the council sets repeat title-block and
section-marker symbols across sheets, so per-sheet counts can be checked by
eye like the existing `count` expectations.

## 2. Legend-driven schedules

Services sheets carry a legend: each symbol drawn once beside its name
("450 m² STORMWATER PIT" on the Dunalley site plan). Find the legend box,
pair each legend symbol with the text to its right, and count every type on
the sheet in one go, producing a labelled schedule, minus the legend's own
copy. This turns "click 12 symbols" into "open the PDF". It reuses the
template matching from (1) plus pdf.js text positions.

## 3. Run lengths by line style

Pipe and cable takeoff is length, not count: "sum every stormwater line on
this sheet". Services are drawn as dashed or coloured lines with a key
(STORMWATER, SEWER MAIN, WATER MAIN on the Dunalley plan). Extend
`vectorPage` to keep each path's stroke colour, width and dash pattern
(`setDash`, `setStrokeRGBColor` and friends in the operator list), then
click one segment and sum the length of every path in that style, at the
page's calibration. Output: one length markup per run, plus a total.

## 4. Near-exact vector matching

The vector tier needs copies to repeat exactly. Two real misses it can't
handle yet:

- the same symbol at several sizes (Kingborough's site-plan trees);
- circles that CAD tessellated differently per copy.

Add a second pass: candidates found by bbox aspect and ink cover alone,
normalised for scale, with no exact seed trace. Keep it opt-in, or rank its
hits below the exact ones, so precise counts stay precise.

## 5. Auto-scale from the title block

Every council sheet prints its scale ("1:100 @A3", "1:200 @ A3"), and the
dimension strings give an independent check (the p42 dimensions measured
within 5 mm). Read the scale text, check it against two printed dimensions,
and calibrate the page with no clicks. Flag sheets where the two disagree,
which happens when a sheet is printed to a different paper size than stated.

## Also worth doing

- **Save into encrypted PDFs.** Kingborough's set is encrypted but allows
  annotations. Write the annotations as an incremental update (appended
  objects plus a new xref) instead of a pdf-lib rewrite.
- **Vector revision compare.** Diff the path sets of two revisions to get
  exact change clouds, without pixel noise. This needs a revision pair in
  the council suite first.
