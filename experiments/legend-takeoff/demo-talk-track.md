# Legend: main hackathon demo track

## The message

**From a drawing to checkable quantities and a price draft.**

The hackathon question is whether a drawing's own symbol examples can make counting easier to verify and carry cleanly into estimating. This prototype lets a person select those examples; automatic legend interpretation and broad accuracy on real drawings are not established.

## Presenter setup

- Open the public landing page and keep the PDF workspace in a second tab.
- Use a permission-cleared digital PDF you have rehearsed. Know the correct count and one likely failure before presenting.
- Without that drawing, choose **Try an electrical sample**. Explicitly call it a synthetic fixture; it switches to electrical presets even if you arrived from General Builders.
- On the sample, mark the entire legend near the top, choose DL1, click the square-with-cross example, then scan. Expected supported count: 3. SO1 has 2 installations if you demonstrate a second type.
- Example rates are fictional AUD $40 material + $20 labour for DL1, and $25 + $15 for SO1. Price only the types you actually assess. Other declared preset types remain unassessed, so the app may correctly label the priced subtotal partial.
- Leave drawing navigation controls visible. Use **Zoom to legend** when choosing an example, then **Fit page** to inspect the installation area.

## Spoken track — approximately three minutes

### 0:00–0:25 — Why this matters

[Show the landing page.]

“Before a builder or subcontractor can price a job, someone has to turn the drawings into quantities. How many items are there? Which types? And what exactly did we include?

Those questions involve repetitive counting, but the difficult part is trusting the result and carrying it into an estimate.

Our hackathon idea is to connect the count, the evidence and the pricing assumptions in one workflow.”

### 0:25–0:45 — Start with the right scope

[Open General Builders or the trade relevant to the audience.]

“We have entry pages for general builders and individual trades. They give people relevant starting labels and make the scope clear.

For a general builder, that might be door sets, windows or joinery units. The labels are editable because the drawing's own codes and specifications are what matter.

Today we're demonstrating item counts and entered rates.”

### 0:45–1:20 — Open a PDF and teach one example

[Open your rehearsed PDF. Alternatively load the electrical sample and use the sentence below.]

“For a repeatable demonstration, this is a synthetic electrical plan with known answers. The same workspace can open a PDF from your device, and processing stays on that device.”

[Mark the legend, zoom to it, select DL1 and choose its example.]

“The drawing already contains a dictionary: its legend. I mark that region so the examples won't be counted as installed equipment.

Then I label one symbol and select its example. The existing takeoff engine searches this page for matching shapes.”

[Run Find matching symbols; return to Fit page.]

“These are the matches it found. The count comes from individual records with positions on the drawing.”

### 1:20–1:55 — Review the evidence

[Select a quantity or a numbered hit; use Zoom to selection.]

“Each reported item has evidence I can inspect. I can confirm it, flag it uncertain, reject it, or manually add an installation the scanner missed.

That distinction matters: a supported detection isn't automatically a human-confirmed item, and reviewing the hits doesn't prove nothing was missed.”

[Temporarily flag one hit on the sample.]

“I'll flag this one to show the review flow. The supported count decreases and the uncertain count stays visible.”

[Confirm the hit again if it is a correct installation.]

“This is a workflow demonstration; the fixture item itself is a correct match.”

### 1:55–2:25 — Carry the count into pricing

[Enter fictional rates, including a source note.]

“Once the quantity is reviewed, I can enter material and installation labour per item.

These rates are fictional for the demo. In a job, the estimator supplies the rate and records its source.

A quantity correction flows through to the priced subtotal. Blank rates stay unpriced, and unresolved or unassessed quantities remain visible as gaps.

This is a price draft for the declared items. Tax, markup and other job costs still need to be considered separately.”

### 2:25–2:50 — Show the handoff

[Point to evidence JSON, quantity/pricing CSV and annotated PDF exports.]

“The handoff includes the quantities, rates and evidence. The annotated drawing lets another person see the numbered items behind the count.

We have also hardened the workflow: a failed replacement PDF keeps the current work, zooming preserves draft inputs, and rescanning retains manually reviewed items.”

### 2:50–3:10 — Close with the experiment

“We're testing whether drawing-specific examples can reduce repetitive takeoff work while keeping the result inspectable.

We have a working on-device workflow and a small synthetic evaluation. Real-world accuracy still needs independent testing, and matching can miss or confuse symbols.

The outcome we're aiming for is less repetitive counting, with a clear trail from each quantity to its evidence and price assumptions.”

## A natural way to explain a failure

If no installed matches are found:

“The engine didn't find supported installation matches for this example. That doesn't establish a quantity of zero. We can choose another example or record items manually, and this is a case we need to improve.”

If similar types are confused:

“These shapes are similar enough to confuse the matcher. I'll flag the item and check its code or specification. The software keeps that uncertainty visible.”

If a PDF cannot open or a page fails:

“This file or page failed to render. The current drawing and work are retained, so we can continue with the rehearsed sample.”

## Short answers for judges

- **Is AI reading the legend?** Not in this version. A person selects and labels an example; the engine matches its appearance. AI review remains proposed.
- **Are the trade pages separate detectors?** No. They provide editable starting labels and scope notes for the same underlying workflow.
- **Can it price a whole building?** It prices supported item counts using entered rates. Length, area, volume, broader job costs and a complete estimate are outside this workspace.
- **Do files leave the device?** The PDF is opened and processed in the browser; the app has no drawing-upload endpoint or cloud AI calls.
- **Does it save projects for reopening?** The local workspace has Save project and Load project for all visited pages. Reopening requires the original PDF and a matching hash. Current-page JSON/CSV/PDF exports are also available. An activity timeline remains planned; verify which version is deployed before presenting.
- **How accurate is it?** The pilot has six synthetic sheets with documented failures. We have not established broad accuracy on real drawings.

## Thirty-second version

“Legend turns a drawing's own symbol examples into quantities you can check. Open a PDF, select an example, scan for matches and review the numbered evidence. Then apply your own material and labour rates and export a price draft. The file stays on your device. Our hackathon prototype focuses on counted items and makes uncertainty visible; the next step is independent testing on real plans.”
