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

## Playgrounds: what makes hands-on explainers work

Studied for the "hands-on" direction (2026-11-21). Main reference: Jake Lazaroff,
*An Interactive Intro to CRDTs* (jakelazaroff.com/words/an-interactive-intro-to-crdts/).

| Source | What works | What Mnemonic takes from it |
|---|---|---|
| Jake Lazaroff, CRDTs | Opens with the finished, working demo ("this is what we'll end up with"). Each concept then gets its own small embedded playground (two peers side by side, a network on/off toggle, a latency slider). After each playground, a short list of **scenarios to try**, each saying what you should notice. The code shown under the playground is the same model that runs it. | Every playground ships with 2–4 guided scenarios written in the content file. Controls include failure injection (drop, delay, forget a step). The model's code is the code the lesson teaches. |
| Bartosz Ciechanowski | Direct manipulation of one variable at a time; every figure responds instantly. | One control changes one thing; the view updates on every input, with no "run" button. |
| Josh W. Comeau | Playgrounds where you edit and immediately see the effect; mistakes are safe and reversible. | Every playground has Reset, and breaking it is part of the lesson. |
| Red Blob Games | You drag the actual objects, and the explanation sits next to the thing you are dragging. | Playgrounds sit inline in the lesson flow, next to the prose that tells you what to try. |

Rules that follow:
1. A playground runs a small **model**: plain TypeScript state plus pure step functions. The view
   only renders state and sends actions, so models can be tested without a browser.
2. Each playground has guided scenarios ("Try this: … Notice that …") in the topic file.
3. The reader can break things on purpose (forget a branch, drop a packet, kill a leader), and
   the model shows the consequence instead of preventing it.
4. Every control works with the keyboard; the event log is announced to screen readers; reduced
   motion swaps animation for instant updates.

## Strategy playground (2026-11-21)

Outcomes the reader should leave with:
1. Adding a provider: in a branch-on-name design the change is spread over several places,
   and with continuous deployment customers hit the half-done states. With Strategy it is one
   unit of change.
2. Changing one provider costs the same in both designs: Strategy pays off where the list of
   variants changes, not everywhere.

Sources checked: an existing interactive Strategy demo
(ozidan13.github.io/SOLID-Principles-Design-Patterns, "payment processing demo") lets you pick
a payment strategy and see the behaviour change. That shows the mechanics but not why the
pattern matters; a first version of ours did the same and the user found it meaningless.
Ours instead runs live traffic through both designs while the reader makes real change
requests, and ends each request with the reader's own numbers (deploys, lines, lost sales,
stuck refunds).
