# Mnemonic: project brief

## What it is
Mnemonic is a free, non-commercial learning site for software skills. It explains concepts as
**interactive docs with professional animation**: calm, doc-style text beside a sticky visual
that animates to match the step the reader is on. Think Josh Comeau or Bartosz Ciechanowski
explainers, with the structure and polish of Stripe-quality docs.
Audience: working engineers and serious learners. **Not for kids**: no cartoon examples such as
animals or shapes. Every example is small, realistic production-style code (payments,
notifications, storage, HTTP middleware, config, queues).
No monetisation, accounts, backend or tracking. Progress is kept in localStorage only.

## Scope: built to scale beyond one topic
It starts with **software design and design patterns**, but the platform must grow into a guide
for *any* software skill: Go internals, Linux and OS, networking, distributed systems, Kubernetes,
low-level and systems topics. Adding a topic must mean writing a content file, not writing code.

## Decisions already made by the user
- **Name:** Mnemonic. Folder: `C:\Users\DELL\Documents\Mnemonic` (its own git repo).
- **Language lens:** Go, Python, TypeScript, Rust. It changes more than syntax: per language,
  how the idea is actually written, a "how much do you need it here" meter (e.g. Template Method
  barely exists in Go; Strategy in Python is often just a function), and where it appears in
  real libraries.
- **Depth lens:** three levels, **Overview / Engineer / Deep** (Deep = runtime or kernel
  level). Readers can always go one level deeper in place.
- **Two modes, one click apart:**
  - **Learn:** a guided interactive lesson.
  - **Reference:** a scannable doc page with a glossary and search.
- **Rejected:** story mode (one app growing across lessons; the user found it confusing) and
  childish examples.
- **Accepted:** morphing before/after diagrams.
- **UX must be simple:** the same lesson workflow everywhere, one lesson per page, no tabs or
  pop-ups inside a lesson, prev/next always visible, keyboard arrows, light and dark themes.

## Lesson anatomy (every topic follows it)
1. **Concept:** a one-sentence definition, the intent, and a small labelled roles diagram.
2. **Problem:** about 15 lines of working but badly designed code with one line of context.
3. **Pain:** a realistic change request arrives. The lines it touches turn red and a
   **change-cost meter** shows the cost ("7 lines, 3 places").
4. **Morph:** a slider or step animation morphs the diagram and code from before to after.
   Hovering a box highlights its code.
5. **How it works:** a numbered walkthrough of one call through the design. Each step
   highlights its diagram part and code lines.
6. **Same request again:** the cost meter now shows something like "1 new file, 0 edits".
7. **Try it:** a hands-on playground (see below). The reader drives a small running model
   and works through 2-4 guided scenarios. Every lesson has one.
8. **Language lens:** the code in the chosen language, plus notes on where the idea appears.
9. **Check:** one question per depth level (Overview, Engineer, Deep), such as a look-alike
   duel or "which situation needs this?". Passing it at a depth marks the lesson done at
   that depth.
- **Optional Practice area:** smell detective, look-alike duels, "overdo it"
  (over-engineered versions, to teach when *not* to use a pattern), and draw-from-memory.
- **Reference pages:** definition, roles, how it works, code per language, use/avoid,
  look-alikes and real-world sightings. A glossary with hover definitions across the site.
  Search. Cheat sheets.

## Hands-on playgrounds (added 2026-11-21)
The user's words: "i like blogs where they let you play with stuff". Main reference:
Jake Lazaroff's *An Interactive Intro to CRDTs*, where the reader changes live state inline
(clicks, edits, toggles) and watches the concept respond, inside the article. Also
Ciechanowski, Josh Comeau and Red Blob Games. Notes: `design/research.md`.
- **Every lesson has at least one playground** where the reader drives a small running model,
  not just watches an animation. It is lesson step 7, "Try it", and can also be placed inline
  anywhere in prose or on a Reference page with `<Playground model="..." />`.
- Planned playgrounds:
  - **Strategy (built):** two checkouts side by side, one with branches on the provider name
    and one with Strategy, both taking live traffic. Change request 1, "Add Klarna": every edit
    ships at once, so the branch design exposes customers to half-done states (lost sales,
    stuck refunds) while the strategy design changes in one step. Change request 2, "PayPal
    changed its refund call": one line in both designs, showing what Strategy does not buy.
  - **Observer:** add or remove subscribers, fire events, watch messages flow.
  - **Decorator:** stack or reorder middleware, see which requests get logged or rejected.
  - Later tracks: Go scheduler (add goroutines, block one in a syscall, watch the P handoff);
    Raft (kill the leader, partition nodes, watch the election); TCP (drop or delay packets);
    virtual memory (touch pages, cause minor or major faults).
- **Every topic gets its own playground design (user, 2026-11-21).** Playgrounds exist so
  people understand; a generic "click to switch and see it change" widget is not enough. For
  each topic, before designing:
  1. Write down what the reader should be able to do or understand after playing (1-3
     outcomes). Every element on screen must serve one of them, or it goes.
  2. Search the web for the best existing interactive explanations of that topic (explorable
     explanations, visualisers, simulators) and note what makes them work.
  3. Design the playground around a realistic situation where the concept's benefit or cost
     shows up through the reader's own actions, and end with a result that uses the reader's
     own numbers and states the takeaway.
  Record the outcomes and the sources in `design/research.md` under that topic.
- **Playground standard (user, 2026-11-21):** "find something on internet which depicts it
  well and you make it into a playground. Think like an innovator trying to make these
  playgrounds serve a purpose for a user." Research the best existing visualisations first;
  one purpose line ("after this, the reader can answer..."); a predict, act, observe, explain
  loop; break-it controls, side-by-side or counterfactual runs, metrics that matter, guided
  challenges; minimal, direct controls; an "Inspired by" line crediting sources (never copy);
  and the 30-second test: someone who skipped the text gets the insight within 30 seconds.
  Full checklist: `docs/AUTHORING.md`.
- **Built from the visualiser kit:** a model (plain TypeScript state plus pure step
  functions, testable without a browser) + controls (buttons, choices, toggles, sliders,
  drag) + a view, all from shared pieces in `src/playgrounds/kit`. Models are registered by
  name in `src/playgrounds/registry.ts`; the build fails if a topic names an unknown model.
- **Guided scenarios** live in the topic file ("Try this... Notice that..."). The reader may
  break things on purpose; the model shows the consequence rather than preventing it.
- Running the reader's own code is optional and not required; simulated models are the core.
- UX rules still apply: inline in the lesson, no pop-ups, full keyboard use, event logs
  announced to screen readers, reduced motion means instant updates.

## Tailored roadmaps (a later phase; the data is designed now)
Like roadmap.sh (https://roadmap.sh), but tailored to a goal and with depth.
- **Lesson metadata** in every topic's frontmatter:
  - `prerequisites`: lesson ids (`<track>/<topic>`) that must come first. Ids of lessons not
    written yet are allowed and reported as warnings at build time.
  - `skills`: tags such as `design`, `concurrency`, `os`, `networking`.
  - `depths`: which of `overview`, `engineer`, `deep` the lesson covers.
  - `checks`: one check question per depth, so "done at this depth" can be verified.
- **A roadmap is a goal profile**: a file in `content/roadmaps/<id>.yaml` listing skills, each
  with a required depth and a reason (for example "Go backend engineer", or "Platform engineer (Go)"). Applied to the content graph, the site computes an ordered path
  (prerequisites first), marks lessons a short placement check shows you already know as
  skippable, and shows on each node *why* the goal needs it.
- **Depth dial per node:** the same lesson can be required at Overview for one goal and at
  Deep for another.
- No backend: profiles are files in the repo; progress is kept in localStorage.
- Possible future tool, separate from the site: generate a profile from a pasted job
  description or review feedback (needs an AI model).

## References given by the user
- https://en.wikipedia.org/wiki/Design_Patterns
- https://refactoring.guru/design-patterns/go
- https://jakelazaroff.com/words/an-interactive-intro-to-crdts/ (the playground model to follow)
- https://roadmap.sh (the roadmap idea to improve on)
- Other websites may be used as references for how to structure and write text; never copy.
- **Books:** the Gang of Four textbook is in `reference/books/`. The user will add more
  textbooks there and offers to provide a book on any topic on request. Books are for checking
  coverage and correctness only: never copy text or diagrams. `reference/books/` and every
  PDF under `reference/` are git-ignored and must never be committed or published.

## Architecture (recommended; refine if research says otherwise)
- **Stack:**
  - Next.js with static export, MDX and TypeScript.
  - Motion (Framer Motion) for step- and scroll-driven animation; SVG diagrams.
  - Shiki for code; Pagefind for static search.
  - Free hosting on GitHub Pages or Vercel.
- **Content separate from code:** one MDX file per topic, in `content/<track>/<topic>.mdx`,
  with frontmatter: track, order, level availability, language variants. The navigation and
  home page are generated from the content.
- **Reusable visualiser kit**, built once and used by every track. This is the core USP:
  - animated box-and-arrow diagrams with before/after morph;
  - a code stepper (line highlight plus variable values);
  - a memory view (stack, heap, pointers, pages);
  - a sequence/timeline view (syscalls, TCP, Raft);
  - a state machine;
  - a packet/layer flow (networking, eBPF, the I/O path).
- **Lenses** are generic: a topic declares which lenses it supports (language, depth, or
  OS later), and the content holds the variants.
- **Accessibility:** respect `prefers-reduced-motion`, full keyboard navigation, readable contrast.

## Design direction (the user asked for distinctive, high-quality design)
- Do real UI research first: look at excellent interactive explainers and developer docs and
  note what works.
- Propose 2-3 distinct visual directions, each with typography (unique but highly readable
  fonts: one display face, one text face, one code face; free licences such as Google Fonts,
  Fontshare or OFL), a colour system, and motion principles. Let the user choose before
  building widely.
- Professional, calm and confident. Not generic SaaS, not playful-childish.

## Reference material in this folder
- `reference/Design_Patterns_in_Go_Visual_Guide.pdf`: a 66-page visual guide written earlier
  in this project. It covers design fundamentals, SOLID and other principles, all 23 GoF
  patterns (each with intent, problem/idea, roles diagram, Go sketch, "in Go" note,
  use/avoid/seen-in), Go concurrency patterns, architecture patterns, smells, anti-patterns,
  and a design-question method. Its source data (Python tuples, with diagram specs and code)
  is in `reference/design-patterns-guide-source/` and can be converted into MDX for the
  design track. That content was fact-checked; keep the fixes.
- `reference/round-guides-source/`: study material on Go internals, testing, debugging,
  shipping and compatibility, Linux (syscalls, virtual memory, the read() path, eBPF),
  networking, Kubernetes and automation. It is raw material for future tracks.
- `reference/books/Design_Patterns_Book.pdf`: *Design Patterns: Elements of Reusable
  Object-Oriented Software* (Gamma, Helm, Johnson, Vlissides, 1994). It is copyrighted: use it
  only to check coverage and correctness, and never copy its text or diagrams. All site content
  is written fresh. Git-ignored.
- **Learning resources the user was given:** https://en.wikipedia.org/wiki/Design_Patterns and
  https://refactoring.guru/design-patterns/go. Use them for research only; do not copy them.

## Plan
1. Research and propose 2-3 design directions; the user picks one.
2. Scaffold the platform: layout, lenses, Learn/Reference modes, the diagram visualiser with
   morph and step animations, glossary hover, and search.
3. Build **one complete topic, Strategy**, in Learn and Reference modes, in all four
   languages and three depth levels. The user reviews it before anything is scaled.
4. Then the design track (principles and all 23 patterns), each with its playground, then new
   visualisers and tracks.
5. Later: the roadmap UI (goal profiles, computed paths, placement checks).

## Status
- 2026-11-21: visual direction chosen: Schematic look with Newsreader for reading text, and
  Graphite for dark mode (`design/directions.html`, option D). Platform scaffolded; Strategy
  built end to end; playground kit, lesson metadata and roadmap data format added.
