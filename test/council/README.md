# Real council drawings (local suite)

`npm test` runs on synthetic PDFs. This suite runs the engine against real
development-application drawing sets that councils publish for public
exhibition: the files that turn up bugs the samples can't.

```bash
node scripts/fetch-council.mjs   # download the sets in manifest.json into cache/
npm run test:council             # ~1.5 min; sets not in cache/ are skipped
```

**The PDFs are never committed.** They are copyright of their authors and
published for exhibition, not redistribution: `cache/` is gitignored, and the
manifest holds only each set's URL, sha256 and notes. Exhibition copies are
taken down when the period closes, so the cache is the durable copy: back it
up rather than relying on the URL. The suite is local-only (not in CI).

## What it checks

Per set, with no hand labelling needed:

- `info` reads it and the page count matches
- every drawing sheet renders without crashing (in a child process, so a
  native crash fails the test), quarter-turned `/Rotate` sheets render with
  swapped dimensions, and a CV scan from automatically chosen ink points
  returns hits that land on the sheet and near the click
- one of every markup type, placed on every drawing sheet, survives save →
  reopen; other tools' annotations are kept; a second save doesn't stack
  copies (edit-restricted sets must instead fail with a clear message)

Plus hand-checked facts under a set's `expect`:

- `length`: two points and a scale must measure a printed dimension
- `count`: scanning from one instance must find this many (the report also
  shows what the raster CV tier finds on its own, as a baseline)
- `schedule`: teaching the symbol on `page` and counting it across the set
  (`scan --all-pages`) must find `counts[page]` on each listed page; list
  only pages you have looked at
- `runs`: clicking one line, every run in its style must total this many
  metres at the scale (check it against a render: the runs should cover the
  line's ink and nothing else)
- `scale`: `pdf2takeoff scale` must read the printed scale (stated ratio,
  paper, effective ratio; `null` = no page default) and, where given, reach
  the dimension cross-check status and find hand-checked dimension ends.
  `ocr` entries read outlined text with tesseract.js; the first run fetches
  its English pack into `~/.cache/pdf2takeoff`, and they skip when that
  can't be fetched.
- `legend`: `pdf2takeoff legend --page N` must schedule `counts` per legend
  row label (legend sample excluded) and, if `lines` is given, list exactly
  those line styles; check the plan by eye, not just the legend

An expectation the engine doesn't meet yet carries `knownIssue` and reports
as a TODO instead of a failure; delete the field once it's fixed.

## Adding a set

```bash
node scripts/fetch-council.mjs add <id> <pdf-url>
```

That downloads it and appends a manifest entry with the sha256; fill in
`council`, `application`, `pages`, `drawingPages` (sheets to render, skipping
reports and forms), `rotatedPages`, `encrypted` and `notes`. Sets that vary
something are worth more than more of the same: rotation, sheet size, scanned
vs vector, text-as-outlines, encryption, existing annotations, or two
revisions of the same sheet.
