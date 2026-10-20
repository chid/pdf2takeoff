# Local feature plan: continuity from drawing to estimate

## Research entry — 2026-10-20

User request: review EasyPDFTakeoff for useful assets and commentary, avoid direct copying, and retain ideas locally for history features. This document records research and proposals; it does not implement history or change the mission's agreed scope. Browser automation remains paused.

### Reference observations

Source: [EasyPDFTakeoff homepage](https://easypdftakeoff.com/), reviewed 2026-10-20. Homepage claims only; the application, downloads, purchase flow and embedded videos were not tested.

The site emphasizes PDF measurement, reusable custom items, structured spreadsheet/PDF exports, and a simple contractor workflow. It also warns that version 2.1 cannot edit older project files. Its related product is positioned around connecting estimates with later business tasks. The homepage does not establish an activity log, review history or versioned rate cards. No advertised speed or accuracy claims were independently verified.

Its visible assets are a logo, a related-product banner and two embedded videos. We retain source references in `assets/README.md` and reuse none of those assets, wording or layout. Our history SVG is original.

### Commentary and independent interpretation

A useful product story continues after the count. An estimator needs to return to the job, reuse a known item definition, and explain why an amount changed. A history should answer a practical question: **“What changed since the estimate I sent?”**

For Legend, separate three causes: a different drawing, a different quantity decision, and a different rate. A price difference alone cannot explain which occurred. This is our proposed direction, not a feature claim about the reference site.

The file-compatibility warning suggests treating save-file versions as a first-class requirement. Reusable templates suggest separating an item definition from drawing-specific exemplars and project-specific rates. Do not silently apply a price or symbol assumption from another job.

## Existing implementation boundaries

Verified locally:

| Area | Exists | Gap in this standalone experiment |
|---|---|---|
| Main app persistence | `src/app/persistence.ts` saves markups, calibrations and presets in IndexedDB | Latest-state persistence is not a chronological event history; the review demo does not use it |
| Drawing comparison | `src/app/compare.ts`, `src/engine/compare.ts`, `src/engine/revdiff.ts` provide overlay and geometry/text comparison | No project revision timeline or automatic cross-revision symbol identity |
| Experiment evidence | Fixture replay plus a real-PDF workspace with stable hit IDs, source hashes, per-page exclusions and current review decisions | Repeated edits are not retained as an event sequence; current-page exports coexist with versioned all-page project save/reopen; activity history is still planned |
| Pricing | Entered rates, source notes and exports in current local changes | No persisted rate library, historical rate versions or saved estimate snapshots |
| Main-app integration | Outside the standalone pilot | Coordinate shared interfaces and persistence changes through the tracking issue |

## Prioritized work — implementation status below

### P0: Save and reopen one local project — implemented locally

The real workspace now saves a versioned JSON project bundle containing original document hash/reference, selected page and coordinate frame, legend/exclusion regions, latest raw scan results, current review decisions, entered rate card, currency, pricing scope and export metadata. Do not bundle customer PDFs by default. Reopening requires opening the original PDF, then choosing Load project; its full hash is verified. The initial project schema is version 1; unknown versions are rejected. No earlier project-bundle schema exists to migrate.

Acceptance: close and reopen a saved bundle, recover the same supported/unresolved quantities and cent totals, and keep the original scan intact. Reject an unknown newer schema with an actionable message. Migrate supported older schemas without replacing the original file. Explicitly report missing source files or unavailable browser storage.

### P1: Review and rate activity history

Record append-only events for hit decisions, legend corrections and rate changes. Store event ID, sequence, timestamp, actor kind, hit/item ID, before/after values, reason and parent snapshot. Record a user review as human input only when performed by the reviewer; never label automated review as human confirmation.

Show a simple timeline with filters for quantity, rate and drawing changes. Selecting an event opens the related evidence. “Undo” creates a compensating event rather than deleting the earlier action. Local timestamps and actor labels are useful context, not verified identity or tamper-proof audit evidence.

Acceptance: confirm → flag → reject retains all three transitions. Undo rejection restores the preceding state. Replaying events yields the same quantities and prices. A second export without edits adds no duplicate hit or decision.

### P1: Named estimate snapshots and comparison

Save snapshots such as “Initial scan”, “Reviewed” and “Price draft sent”. Each pins source hash, scan configuration, review-state version, rate version, currency and scope. A snapshot is immutable; edits create a later version.

Compare quantity changes separately from rate changes. For each item use this documented decomposition:

- Quantity effect = (new quantity − old quantity) × old unit rate.
- Rate effect = new quantity × (new unit rate − old unit rate).
- Sum = change in priced subtotal for comparable lines.

Do not compute a delta when quantity/rate is unknown, currency differs, or scope is incomparable. Show those lines explicitly as not comparable. Link every amount to its evidence and source note. Compare supported-quantity coverage as well as money; a lower subtotal can reflect lost assessment coverage.

Acceptance: rejecting a hit changes only the quantity contribution; editing a rate changes only the rate contribution. Frozen snapshots retain their original amounts after later edits.

### P2: Drawing revision history

Allow explicit Rev A / Rev B inputs with source hashes and page pairing. Reuse existing comparison APIs before adding new processing. Registration, page rotation and alignment must be explicit. Highlight possible added, removed or moved equipment, then require a separate review on the new revision.

Do not carry a prior confirmed decision across revisions solely because coordinates are nearby. Existing hit IDs include a document hash, so different documents require an explicit correspondence record rather than rewriting old IDs.

Acceptance: a changed drawing starts a new evidence set, preserves the old estimate, and shows quantity/price differences without double-counting prior markups. Misaligned or unmatched pages are unresolved rather than “no change”.

### P2: Reusable item and rate library

Keep three layers: item identity/description; drawing-specific exemplar and bounds; dated rates and supplier/source notes. Suggest a saved item match but require confirmation before reusing its pricing. Version reusable templates; update future drafts without mutating historical snapshots. Keep missing rates distinct from zero and never infer compatibility from the same symbol code alone.

### Later: Handoff package

Export a readable change summary alongside quantities, evidence and price drafts. Include exclusions, coverage, unresolved items, original source hash, snapshot IDs and rate-source notes. Regenerate a reviewed annotated PDF from the chosen snapshot; today's PDF still represents the original scan. Purchasing, invoicing, live supplier feeds and cloud accounts are outside this proposed increment.

## Proposed history demo story

1. Save a five-item original scan.
2. Reject one DL1; show the quantity change and its evidence.
3. Change the DL1 material rate from a fictional AUD $40 to $45 with a source note.
4. Compare the two snapshots; separate the review correction from the rate increase.
5. Reopen the saved project and export the same price draft.

The new `assets/project-history.svg` previews this story. It is illustrative and labelled planned; none of these persistence/history interactions are currently shipped in the review demo.

## Original landing-page commentary

“Know why the estimate changed. A drawing revision, a review correction and a new supplier rate should each leave a clear trail. Our next step is a local project history that keeps those changes connected to their evidence.”

This copy was written for Legend. It describes a proposed feature and is presented with a visible planned label.

## Decision log

- 2026-10-20: Save the reference review and feature proposals locally; no external publishing or posting.
- 2026-10-20: Add original SVG and planned-history commentary to the landing page; reuse no competitor assets.
- 2026-10-20: Prioritize save/reopen and review/rate history before cross-revision matching or business integrations.
- 2026-10-20: Keep implementation out of shared app/engine interfaces until scope is agreed through the issue. No new dependencies for research or landing assets.

- 2026-10-20: Added a real-PDF workspace with live on-device scanning, manual review/additions, per-page isolation and pricing. History/save-reopen features remain proposed; the fixture replay remains a separate demo.

- 2026-10-20: Added trade-specific entry pages and editable presets for electrical, plumbing, HVAC, fire and security/data, plus pointer-anchored zoom, pan and fit controls. These additions use the same scanner and do not add trade-trained detection or length/area measurements.

- 2026-10-20: Added General Builders entry page/presets and hardened the real-PDF controller against failed file/page loads, duplicate manual/scanner records, draft loss during zoom and overlapping sample loads. These are application changes; no broader detection accuracy is claimed.

- 2026-10-20: Implemented local version 1 project save/reopen, unsaved-work protection, reversible page scope, crop-aware counts, preserved review decisions and stale-exemplar detection. Current-state restore is available; event history and named snapshots remain planned. No publication is implied.
