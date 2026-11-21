# Authoring a Mnemonic lesson

Read this whole file before writing. The finished example to copy the structure from is
`content/design-patterns/strategy.mdx` with its playground in
`src/playgrounds/strategy-checkout/` (model.ts, View.tsx) and its tests in
`tests/models.test.ts`. Project-wide decisions are in `BRIEF.md`.

## 1. What you own (one writer per file)

For a lesson with slug `<slug>` in track `<track>` you create and own only:

| File | What |
|---|---|
| `content/<track>/<slug>.mdx` | The lesson: YAML frontmatter + MDX prose |
| `src/playgrounds/<slug>/model.ts` | The playground model: plain state + pure `step(state, action)` |
| `src/playgrounds/<slug>/View.tsx` | The playground view, default export, built from `src/playgrounds/kit.tsx` |
| `tests/<slug>.test.ts` | Node tests for the model (import with explicit `.ts` paths) |
| `content/glossary/<slug>.yaml` | Optional: glossary terms your lesson introduces |

Never edit any other file (no `globals.css`, kit, components, `skills.yaml`, `tracks.yaml`,
`glossary.yaml`, other lessons). If you need a shared change (a kit component, a CSS rule, a
skill tag), describe it in your report; the integrator adds it. Playgrounds register
automatically from their folder. The playground folder name is the lesson's `playground.model`.
Styling: use the existing `pg-*` classes from `src/app/globals.css` (see the Strategy View); if
you need a few lesson-specific styles, put them in a `<style>` block inside your View using
classes prefixed with your slug, and tokens only (`var(--accent)`, `var(--line)`, ...).

Commands you may run (they are safe to run in parallel):
- `npm run check content/<track>/<slug>.mdx` validates your lesson, compiles the MDX and
  highlights every code variant.
- `npm run typecheck`
- `npm test`

Never run `npm run build`, `npm run dev` or any git command. The integrator builds, renders,
reviews and commits.

## 2. The lesson contract

Nine steps, same order everywhere, each an MDX section `## [key] Title`:
`concept`, `problem`, `pain`, `morph`, `walk`, `again`, `play`, `lens`, `check`, then an optional
`## [reference]` section (usually `### Try it` with `<Playground model="<slug>" />`, plus one
short extra section).

Frontmatter (copy the shape from strategy.mdx exactly):
- `title, track, group, order, summary, intent, changeRequest, languages: [go, python, typescript, rust]`
- `glossary: [...]` term ids used on the Reference page.
- `prerequisites` (lesson ids `<track>/<slug>`), `skills` (ids from `content/skills.yaml`),
  `depths: [overview, engineer, deep]`, `checks` with one question per depth (exactly one
  `correct: true` each, every option has a `why`).
- `playground: { model: <slug>, scenarios: [{ try, notice }, ...] }` with 2-4 scenarios.
  Quote any YAML string that contains `: ` or starts with a backtick.
- `diagram`: nodes with `before` and `after` boxes (SVG units in a `width` x `height` viewBox,
  usually 560 x 270), `kind` one of `client` (who picks/calls), `context` (the main class; its
  before-box is drawn big with the label top-left), `strategy` (the abstraction/interface role,
  dashed accent), `concrete` (implementations). `appears: after` fades in during the morph;
  `appears: change` is the new variant (ghost in Pain, green in Same request again). Titles and
  subs may be per language. Edges: `{ from, to, label?, kind?: implements }`. Keep boxes inside
  the viewBox and labels short (titles render uppercase in a mono face; about 7 px per char).
- `code.<lang>` for all four languages: `before` (file, source, roles, change), `after` (file,
  source, roles), `again` (file, source), `cost` (before/after `{ text, value 0..1 }`), `lens`
  (`need 1-4, needLabel, note, seenIn`). Line numbers in `roles` and `change` are 1-based on
  the `before`/`after` source. `change` ops: `{ after: n, add: [lines] }` or
  `{ line: n, replace: "new text" }`. `after.roles` must include every `walk[].role`; node ids
  in roles light up code when the box is hovered (concrete nodes fall back to `strategy`).
- `walk`: 3-5 steps `{ text (per-language allowed), nodes, edges ("from>to"), role }`.
- `reference`: roles, useWhen, avoidWhen, tradeoffs, lookalikes.

Prose components: `<Depth level={2}>` (Engineer) and `<Depth level={3}>` (Deep),
`<Lang only="go">`, `<Term id="...">text</Term>` (term must exist in `content/glossary.yaml` or
your `content/glossary/<slug>.yaml`; check first, reuse existing ids), `<Playground model="..."/>`.

## 3. Content quality

- Audience: working engineers. Realistic production examples (payments, notifications,
  storage, HTTP, config, queues, deploys, billing). No animals, shapes, pizzas or cars.
- The example must make the pattern *necessary*: the change request in Pain must be one a
  real team gets, and the before-code must be plausible code a competent engineer wrote.
- Code must be correct, idiomatic and compile in spirit for each language (Go, Python 3.12,
  TypeScript 5, Rust 2021). Use each language's real idiom (Go: small interfaces, func values;
  Python: callables, Protocols, context managers, decorators-as-functions where relevant;
  TS: structural types; Rust: traits, generics vs `dyn`, ownership). Where the pattern is
  barely needed in a language, say so in `lens` and show the light version.
- Facts must be right. Check claims about the original catalogue against the textbook in
  `reference/books/design-architecture/` (read it with `pdftotext`; never copy its text,
  code or diagrams). "Seen in" examples must be real APIs you are sure of.
- Writing: plain, direct, active voice, short sentences. No em-dash asides, no "not X but Y",
  no colon-then-reveal, no scare quotes, no filler. Explain from the reader's side.
- Overview depth: what and why, in two short paragraphs. Engineer: trade-offs and how to use
  it well. Deep: runtime, compiler or library level, per language where it differs.

## 4. The playground standard (most important)

The user's words: "find something on internet which depicts it well and you make it into a
playground. Think like an innovator trying to make these playgrounds serve a purpose for a
user." A playground that is a form with buttons, or that only switches between variants and
shows they behave differently, has failed.

For each playground:
1. **Research first.** Search the web for the best existing visualisations or interactive
   explainers of the concept (refactoring.guru diagrams, explorable explanations, visualisers,
   teaching demos, conference talks). Note what makes each click. Put 1-3 of them in a
   `<PgSources>` line at the bottom of your View, and list them in your report.
2. **Write the purpose first:** "After this, the reader can answer: ___." One core insight,
   not a feature tour. Put it as a comment at the top of model.ts.
3. **Loop: predict, act, observe, explain.** Ask the reader to predict first (`PgPredict`),
   let them act on the model, show the result in the model, and explain why in one line.
4. **Innovate on top:** break-it controls (trigger the real failure mode), side-by-side runs
   or counterfactual toggles (same input, design A vs design B), metrics that matter (lines
   touched, deploys, messages sent, objects created, memory used, calls made), and guided
   challenges ("make the refund fail", "find the order that deadlocks"). Reset always.
5. **Direct manipulation, minimal controls:** click the node, toggle the line, drag the item.
   Every control is a real `<button>` (or input) so the keyboard works. Motion is short and
   purposeful (CSS transitions or the kit's `pg-hop` animation) and disappears under
   `prefers-reduced-motion` (`useModel` returns `reduced`).
6. **End with the reader's own result:** a sentence that uses their numbers and states the
   takeaway, like the Strategy playground's "What this request cost".
7. **30-second test:** someone who skipped the text must get the one insight within 30
   seconds of playing. If not, redesign.
8. Visual direction: Schematic look (square corners, mono uppercase labels, grid paper,
   teal accent), both light and dark via tokens only, works at 360 px width.

The model must be pure and fully tested: the tests should play the guided scenarios and
assert the outcomes the lesson promises (for example "forgetting X makes Y fail").

## 5. Your report (keep it short)

1. Files created.
2. The playground purpose line, the predict question, and how it passes the 30-second test.
3. Research sources (title + URL) and what you took from each.
4. Facts you checked, and anything you were unsure of.
5. Shared changes you need (kit, CSS, skills, glossary in the shared file), if any.
6. Output of `npm run check <file>`, `npm run typecheck` and `npm test` (pass/fail lines).

## 6. Systems tracks (Go internals, Linux, networking, distributed systems, ...)

The nine steps stay the same, so readers meet one workflow everywhere. Read them like this:
- **Concept:** the one-sentence model of the mechanism, and a roles diagram of its parts
  (for example G, M and P; process, page table and page cache; client, leader and followers).
- **Problem:** realistic production code written with the naive mental model (an HTTP handler
  that makes a blocking syscall, a cache that reads files assuming they are in memory, a client
  with no timeout). It works in testing.
- **Pain:** the production symptom that the naive model cannot explain (latency spike, page
  fault storm, a request that hangs forever on a lost packet, a split brain), with the marked
  lines that matter. The cost meter shows the cost of the symptom (ms of latency, faults,
  stuck requests, lost writes).
- **Morph:** the diagram morphs from the naive model to the real mechanism (before: what you
  thought happens; after: what the runtime, kernel or protocol actually does). The code
  morphs from the naive version to the version that works with the mechanism.
- **How it works:** one operation traced through the real mechanism, step by step.
- **Same request again:** the same symptom with the corrected code: now it costs little.
- **Try it:** the playground drives a simulation of the mechanism itself (a scheduler with Ps
  and run queues, a page table and page cache, a lossy link with timers, a cluster with a
  partition). The reader breaks it (block a goroutine in a syscall, evict pages, drop packets,
  kill the leader) and watches the mechanism respond.
- **Language lens:** how each of Go, Python, TypeScript (Node.js) and Rust meets the mechanism
  (goroutines vs asyncio vs the Node event loop vs tokio; how each reads a file; which socket
  timeouts each exposes). Code in all four languages is still required.
- **Check:** one question per depth.

Use `content/outlines/<track>.yaml` for lesson ids, titles, prerequisites and skills, and the
lesson's section in `reference/notes/<category>.md` (local only) for depth content, check ideas,
the playground idea and facts to verify. Notes are working material: write the lesson fresh.
Everything flagged "verify" must be checked against current official docs (go.dev, kernel.org
docs, man7.org, RFCs, Raft paper) before it is stated. Books in `reference/books/<category>/`
are for checking only. Set `group` to a short section name for the track page (for example
"Scheduler", "Memory", "Files", "TCP", "Replication").
