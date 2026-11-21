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
7. **Language lens:** the code in the chosen language, plus notes on where the idea appears.
8. **Check:** one question, such as a look-alike duel or "which situation needs this?".
- **Optional Practice area:** smell detective, look-alike duels, "overdo it"
  (over-engineered versions, to teach when *not* to use a pattern), and draw-from-memory.
- **Reference pages:** definition, roles, how it works, code per language, use/avoid,
  look-alikes and real-world sightings. A glossary with hover definitions across the site.
  Search. Cheat sheets.

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
- **The user will add** the textbook *Design Patterns: Elements of Reusable Object-Oriented
  Software* (Gamma, Helm, Johnson, Vlissides, 1994). It is copyrighted: use it only to check
  coverage and correctness, and never copy its text or diagrams. All site content is written
  fresh.
- **Learning resources the user was given:** https://en.wikipedia.org/wiki/Design_Patterns and
  https://refactoring.guru/design-patterns/go. Use them for research only; do not copy them.

## Plan
1. Research and propose 2-3 design directions; the user picks one.
2. Scaffold the platform: layout, lenses, Learn/Reference modes, the diagram visualiser with
   morph and step animations, glossary hover, and search.
3. Build **one complete topic, Strategy**, in Learn and Reference modes, in all four
   languages and three depth levels. The user reviews it before anything is scaled.
4. Then the design track (principles and all 23 patterns), then new visualisers and tracks.
