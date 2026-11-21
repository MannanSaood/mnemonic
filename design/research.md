# Mnemonic: design research notes

Step 1 of the plan in `BRIEF.md`. These notes record what we take from strong interactive
explainers and developer docs, and why the three visual directions look the way they do.
The rendered comparison is `design/directions.html`.

## What the best explainers do

| Source | What works | What Mnemonic takes from it |
|---|---|---|
| Bartosz Ciechanowski (ciechanow.ski) | Every figure is a small instrument: sliders, drag handles, no decoration. Prose and figure alternate, and each figure answers one question. | One question per visual state. A slider is the main control for the Morph step. |
| Josh W. Comeau (joshwcomeau.com) | Interactive code next to its result; calm text with playful but precise widgets; strong typography. | Hover a diagram box to highlight its code. Warm, direct prose. |
| Sam Rose (samwho.dev) | One idea per figure; dots travel along paths to show a request moving. | A pulse along the edges in "How it works" shows one call through the design. |
| Red Blob Games | Direct manipulation: you move the thing itself, not a remote control. | Diagram boxes are hover targets; the morph is scrubbed, not just played. |
| Stripe docs | Prose left, code right; the chosen language persists across every page. | The language lens is global and remembered. Code panel always beside the prose. |
| React docs (react.dev) | "Deep dive" sections are optional depth, in place, without leaving the page. | The depth lens adds paragraphs in place: Overview, Engineer, Deep. |
| Distill.pub | Figures and text share one grid; captions are part of the argument. | Diagram captions carry meaning; figures align to the text grid. |
| The Pudding / NYT scrollytelling | A sticky visual that changes as the reader moves through steps. | The lesson is a sticky visual with stepped prose. We use explicit Prev/Next steps instead of scroll-jacking, which keeps arrows and links predictable. |

## Rules that follow from this

1. One lesson workflow everywhere: eight fixed steps, the same controls in the same places.
2. The visual is sticky and changes only when the step changes or the reader moves a control.
3. No scroll-jacking. Steps change with Prev/Next, the step rail, or the arrow keys.
4. Motion explains a change of state. Nothing loops or moves on its own.
5. `prefers-reduced-motion` turns every transition into an instant state change.
6. All type is from Google Fonts under the SIL Open Font License, so it can be self-hosted
   with the static export.

## Font licences (all verified on Google Fonts, SIL OFL 1.1)

- Margin: Fraunces, Newsreader, IBM Plex Mono
- Schematic: Bricolage Grotesque, Instrument Sans, Martian Mono
- Signal: Archivo (expanded width), Atkinson Hyperlegible Next, Atkinson Hyperlegible Mono
