# Contributing to pdf2takeoff

Thanks for wanting to help. This page sets expectations up front so nobody
wastes their time — including yours.

## The most valuable contribution isn't code

We're building a takeoff tool for estimators, so the single most useful thing
you can contribute is **knowledge of the trade**: what does your takeoff
actually look like? Which symbols do you count by hand, on which trades, and
what does your boss want in the Excel export? Open an issue titled
`[trade] …` describing your workflow. That shapes the roadmap more than any PR.

## Ground rules

1. **Issue first, PR second.** For anything beyond a typo or obvious bug fix,
   open an issue and get a 👍 before writing code. Unrequested feature PRs
   will be closed politely.
2. **Small, scoped PRs.** One thing per PR. If it touches more than ~3 files or
   restructures anything, it needs an agreed issue and probably should be
   discussed in stages.
3. **CI must pass.** `npm ci && npm run build && npm test` green is the first review.
4. **No new dependencies without discussion.** The permissive-licence,
   zero-backend architecture is a feature (see STRATEGY.md). Propose the dep in
   an issue first.
5. **No drive-by refactors, formatting sweeps, framework migrations or
   "modernisation" PRs.** They will be closed.
6. **Describe how you verified it.** Which drawing (the bundled samples are
   fine), which browser, what you clicked, what you saw. UI changes need a
   screenshot.

## What we especially want

- Bug reports with real drawings described (vector vs scanned, page size,
  what broke)
- Trade-specific measurement needs (rebar? duct runs? cable lengths?)
- Accessibility fixes
- Small, boring, correct fixes

## Development quickstart

```bash
npm ci
npm run dev      # http://localhost:5173
npm run sample   # regenerate the demo drawings
npm run build    # typecheck + production build
npm test         # engine tests (Node built-in runner)
```

The bundled sample (`Try the sample drawing`) has a printed 12.00 m dimension
for testing calibration, repeated symbols for testing Scan, and a revision B
for testing overlay compare.

## Licensing

By contributing you agree your contributions are licensed under the project's
Apache-2.0 licence.

## Conduct

Be civil and constructive. Estimators, developers, students and suppliers are
all welcome here; gatekeeping isn't.
