# Mnemonic

Free, interactive guides to software design and systems topics. Each lesson starts with working
code, sends it a realistic change request, shows what the change costs, then morphs the design and
walks one call through it. Code is shown in Go, Python, TypeScript and Rust, at three depths.

No accounts, no tracking. Progress and settings stay in the reader's browser (localStorage).

Live at https://mannansaood.github.io/mnemonic/

## What is in it

114 lessons across all 23 tracks, each with its own hands-on playground:

| Track | Lessons |
|---|---|
| Software design and design patterns (7 principles, all 23 patterns) | 30 |
| Go internals | 9 |
| Distributed systems | 9 |
| Linux, Networking | 6 each |
| Concurrency, Operating systems, Databases, System design, Software architecture, Kubernetes, Performance, Reliability, Testing, Code craft, Security, Algorithms, Math for CS, Computer architecture, Compilers, Python, TypeScript, Rust | 3 each |

Every track page also lists its full planned outline (coming soon), and `/roadmaps` turns a
goal (for example "Go backend engineer") into an ordered path through written and planned
lessons.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000, live reload (search is off in dev)
npm run build        # static site in out/, plus the Pagefind search index
npm start            # serve out/ to try the built site, including search
```

For a GitHub Pages project site, build with `BASE_PATH=/<repo-name> npm run build`.

## Add a topic

A topic is one file: `content/<track>/<topic>.mdx`. No code changes are needed.

- **Frontmatter (YAML)** holds the structure: the diagram (boxes for the before and after
  designs, and the edges), the code for each language (before, the change request as added or
  replaced lines, after, and the "same request again" addition), line ranges for each role,
  the cost meter, the language-lens notes, the walk-through steps, the check question and the
  Reference page data.
- **Roadmap metadata** in the frontmatter: `prerequisites` (lesson ids), `skills` (from
  `content/skills.yaml`), `depths` (overview, engineer, deep) and `checks`, one question per
  depth.
- **A playground** (`playground.model` plus 2-4 `scenarios`): every lesson has one. Models live
  in `src/playgrounds/<name>/` (a pure `model.ts` and a `View.tsx` built from
  `src/playgrounds/kit.tsx`) and are registered in `names.ts` and `Playground.tsx`.
  `<Playground model="..." />` also works anywhere in the prose.
- **Body (MDX)** holds the prose for the nine steps, each under a heading
  `## [key] Title`, in this order: `concept`, `problem`, `pain`, `morph`, `walk`, `again`,
  `play`, `lens`, `check`. An optional `## [reference]` section adds prose to the Reference page.
- Inside the prose: `<Depth level={2}>` (Engineer) and `<Depth level={3}>` (Deep) for
  optional depth, `<Lang only="go">` for language-specific text, and
  `<Term id="interface">` for glossary hover definitions (`content/glossary.yaml`).

`content/design-patterns/strategy.mdx` is the reference example. The build checks every
topic and stops with a clear message if a step, role or line range is missing or wrong.

Tracks are listed in `content/tracks.yaml`; a track goes live when it has a topic.
Roadmap goal profiles are in `content/roadmaps/`; `src/lib/roadmap.ts` turns a profile into an
ordered path (the roadmap pages come later).

`npm test` runs the playground model and roadmap tests (no browser needed). `npm run check`
validates every lesson without a full build.

The full authoring guide, including the playground standard every lesson must meet, is in
[docs/AUTHORING.md](docs/AUTHORING.md).

## Layout

```
content/              topics, tracks, glossary
src/app/              pages: home, track, Learn, Reference, glossary
src/components/       Lesson (the 8-step workflow), Diagram (morph), CodePanel, LensBar, ...
src/lib/              content loading and validation, Shiki highlighting, MDX
design/               the visual-direction comparison and research notes
reference/            source material; reference/books/ and all PDFs are git-ignored
```

## Design

Look: "Schematic" with Newsreader for reading text, and Graphite for dark mode. Fonts are
Bricolage Grotesque, Newsreader and Martian Mono (SIL Open Font License), self-hosted by
`next/font`. See `design/research.md`.
