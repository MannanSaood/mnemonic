import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import YAML from "yaml";
import {
  DEPTH_NAMES,
  LANGS,
  STEP_KEYS,
  type CodeLine,
  type GlossaryEntry,
  type Lang,
  type LangCode,
  type PreparedCode,
  type PreparedLang,
  type RoadmapProfile,
  type SkillEntry,
  type StepKey,
  type TopicMeta,
  type Track,
} from "./types.ts";
import { highlightLines } from "./highlight.ts";

const CONTENT = path.join(process.cwd(), "content");
const PLAYGROUNDS = path.join(process.cwd(), "src", "playgrounds");

/** Playgrounds are folders src/playgrounds/<name>/ with a View.tsx (registered automatically). */
export function playgroundNames(): string[] {
  return fs.readdirSync(PLAYGROUNDS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PLAYGROUNDS, d.name, "View.tsx")))
    .map((d) => d.name);
}

export interface StepSource { key: StepKey; title: string; mdx: string }
export interface Topic { meta: TopicMeta; steps: StepSource[]; reference: string }

/* ---------------- tracks and glossary ---------------- */

export function getTracks(): Track[] {
  return YAML.parse(fs.readFileSync(path.join(CONTENT, "tracks.yaml"), "utf8")) as Track[];
}

let glossaryCache: Record<string, GlossaryEntry> | null = null;
export function getGlossary(): Record<string, GlossaryEntry> {
  if (glossaryCache) return glossaryCache;
  // content/glossary.yaml plus one optional file per lesson in content/glossary/*.yaml
  const files = [path.join(CONTENT, "glossary.yaml")];
  const dir = path.join(CONTENT, "glossary");
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(".yaml")) files.push(path.join(dir, f));
  glossaryCache = {};
  for (const f of files) {
    for (const g of (YAML.parse(fs.readFileSync(f, "utf8")) ?? []) as GlossaryEntry[]) {
      if (glossaryCache[g.id] && glossaryCache[g.id].short !== g.short)
        throw new Error(`[content] glossary term "${g.id}" is defined twice with different text (${path.relative(process.cwd(), f)})`);
      glossaryCache[g.id] = g;
    }
  }
  return glossaryCache;
}

export function getSkills(): Record<string, SkillEntry> {
  const list = YAML.parse(fs.readFileSync(path.join(CONTENT, "skills.yaml"), "utf8")) as SkillEntry[];
  return Object.fromEntries(list.map((x) => [x.id, x]));
}

export function listRoadmaps(): RoadmapProfile[] {
  const dir = path.join(CONTENT, "roadmaps");
  if (!fs.existsSync(dir)) return [];
  const skills = getSkills();
  return fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => {
    const r = YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RoadmapProfile;
    r.id = r.id || path.basename(f, ".yaml");
    for (const g of r.goals) {
      if (!skills[g.skill]) fail(`content/roadmaps/${f}`, `unknown skill "${g.skill}" (add it to content/skills.yaml)`);
      if (!(DEPTH_NAMES as readonly string[]).includes(g.depth)) fail(`content/roadmaps/${f}`, `depth for "${g.skill}" must be overview, engineer or deep`);
    }
    return r;
  });
}

/* ---------------- topics ---------------- */

const STEP_RE = /^## \[([a-z]+)\]\s*(.+)$/gm;
const REF_RE = /^## \[reference\]\s*$/m;

function fail(file: string, msg: string): never {
  throw new Error(`[content] ${file}: ${msg}`);
}

function parseTopic(file: string): Topic {
  const raw = fs.readFileSync(file, "utf8");
  const { data, content } = matter(raw, { engines: { yaml: (s: string) => YAML.parse(s) as object } });
  const meta = data as TopicMeta;
  meta.slug = meta.slug || path.basename(file, ".mdx");
  meta.id = `${meta.track}/${meta.slug}`;
  meta.prerequisites ??= [];
  meta.skills ??= [];

  // Optional trailing "## [reference]" section: extra prose for the Reference page only.
  let body = content;
  let reference = "";
  const refAt = body.search(REF_RE);
  if (refAt >= 0) {
    reference = body.slice(refAt).replace(REF_RE, "").trim();
    body = body.slice(0, refAt);
  }

  const steps: StepSource[] = [];
  const marks = [...body.matchAll(STEP_RE)];
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    steps.push({ key: m[1] as StepKey, title: m[2].trim(), mdx: body.slice(start, end).trim() });
  });

  validate(file, meta, steps, body + reference);
  return { meta, steps, reference };
}

function validate(file: string, meta: TopicMeta, steps: StepSource[], prose: string) {
  const rel = path.relative(process.cwd(), file);
  for (const k of ["title", "track", "group", "summary", "intent", "changeRequest"] as const)
    if (!meta[k]) fail(rel, `frontmatter is missing "${k}"`);
  const keys = steps.map((s) => s.key);
  if (keys.join() !== STEP_KEYS.join())
    fail(rel, `the body must have the eight steps in order (${STEP_KEYS.join(", ")}); found ${keys.join(", ") || "none"}`);
  const nodeIds = new Set(meta.diagram.nodes.map((n) => n.id));
  for (const e of meta.diagram.edges) if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) fail(rel, `edge ${e.from}>${e.to} names an unknown node`);
  for (const lang of meta.languages) {
    const c = meta.code?.[lang];
    if (!c) fail(rel, `code.${lang} is missing`);
    for (const part of ["before", "after", "again", "cost", "lens"] as const) if (!c[part]) fail(rel, `code.${lang}.${part} is missing`);
    const checkRanges = (variant: "before" | "after") => {
      const n = c[variant].source.replace(/\n$/, "").split("\n").length;
      for (const [role, [a, b]] of Object.entries(c[variant].roles))
        if (a < 1 || b > n || a > b) fail(rel, `code.${lang}.${variant}.roles.${role} = [${a}, ${b}] is outside 1..${n}`);
    };
    checkRanges("before");
    checkRanges("after");
    for (const w of meta.walk) if (!c.after.roles[w.role]) fail(rel, `walk role "${w.role}" has no line range in code.${lang}.after.roles`);
  }
  for (const w of meta.walk) for (const id of w.nodes) if (!nodeIds.has(id)) fail(rel, `walk names unknown node "${id}"`);
  // roadmap metadata
  const skills = getSkills();
  if (!meta.skills.length) fail(rel, "skills must list at least one skill");
  for (const sk of meta.skills) if (!skills[sk]) fail(rel, `unknown skill "${sk}" (add it to content/skills.yaml)`);
  if (!meta.depths?.length) fail(rel, "depths must list overview, engineer and/or deep");
  for (const d of meta.depths) {
    if (!(DEPTH_NAMES as readonly string[]).includes(d)) fail(rel, `unknown depth "${d}"`);
    const c = meta.checks?.[d];
    if (!c) fail(rel, `checks.${d} is missing: every depth the lesson covers needs a check`);
    if (c.options.filter((o) => o.correct).length !== 1) fail(rel, `checks.${d} needs exactly one option with correct: true`);
  }
  // playgrounds: the lesson's own, and any <Playground model="..."> in the prose
  const names = playgroundNames();
  if (!meta.playground?.model) fail(rel, "playground.model is missing: every lesson has a playground");
  if (!names.includes(meta.playground.model)) fail(rel, `unknown playground "${meta.playground.model}" (known: ${names.join(", ")})`);
  if (!meta.playground.scenarios?.length) fail(rel, "playground.scenarios needs at least one scenario");
  for (const m of prose.matchAll(/<Playground\s+model="([^"]+)"/g))
    if (!names.includes(m[1])) fail(rel, `unknown playground "${m[1]}" in the prose`);
  // glossary terms and lens names used in the prose
  const gl = getGlossary();
  for (const m of prose.matchAll(/<Term\s+id="([^"]+)"/g)) if (!gl[m[1]]) fail(rel, `unknown glossary term "${m[1]}" (add it to content/glossary/<topic>.yaml)`);
  for (const m of prose.matchAll(/<Lang\s+only="([^"]+)"/g)) if (!meta.languages.includes(m[1] as Lang)) fail(rel, `<Lang only="${m[1]}"> is not one of this topic's languages`);
  for (const id of meta.glossary ?? []) if (!gl[id]) fail(rel, `glossary list names unknown term "${id}"`);
  // code: before.change must point at real lines, and every walk step needs real nodes and edges
  for (const lang of meta.languages) {
    const n = meta.code[lang].before.source.replace(/\n$/, "").split("\n").length;
    for (const op of meta.code[lang].before.change)
      if ((op.after ?? op.line ?? 0) < 1 || (op.after ?? op.line ?? 0) > n) fail(rel, `code.${lang}.before.change points at line ${op.after ?? op.line}, outside 1..${n}`);
  }
  const edgeIds = new Set(meta.diagram.edges.map((e) => `${e.from}>${e.to}`));
  for (const w of meta.walk) for (const e of w.edges) if (!edgeIds.has(e)) fail(rel, `walk names edge "${e}", which is not in diagram.edges`);
}

let prereqWarned = false;
export function listTopics(): TopicMeta[] {
  const out: TopicMeta[] = [];
  for (const track of fs.readdirSync(CONTENT, { withFileTypes: true })) {
    if (!track.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(CONTENT, track.name))) {
      if (f.endsWith(".mdx")) out.push(parseTopic(path.join(CONTENT, track.name, f)).meta);
    }
  }
  // Prerequisites may name lessons that are not written yet: warn once, do not fail.
  const ids = new Set(out.map((t) => t.id));
  if (!prereqWarned) {
    prereqWarned = true;
    for (const t of out) for (const p of t.prerequisites)
      if (!ids.has(p)) console.warn(`[content] ${t.id}: prerequisite "${p}" is not written yet`);
  }
  return out.sort((a, b) => a.order - b.order);
}

export function getTopic(track: string, slug: string): Topic {
  const file = path.join(CONTENT, track, `${slug}.mdx`);
  return parseTopic(file);
}

/* ---------------- code preparation ---------------- */

function splitLines(src: string) {
  return src.replace(/\n$/, "").split("\n");
}

async function prepareLang(lang: Lang, c: LangCode): Promise<PreparedLang> {
  const baseLines = splitLines(c.before.source);

  // Pain: the change request applied to the "before" code. Added lines have no number.
  const painText: string[] = [];
  const painKinds: { n: number | null; kind: CodeLine["kind"] }[] = [];
  baseLines.forEach((text, i) => {
    const n = i + 1;
    const rep = c.before.change.find((op) => op.line === n && op.replace !== undefined);
    painText.push(rep ? rep.replace! : text);
    painKinds.push({ n, kind: rep ? "mod" : "base" });
    for (const op of c.before.change.filter((o) => o.after === n))
      for (const add of op.add ?? []) {
        painText.push(add);
        painKinds.push({ n: null, kind: "add" });
      }
  });

  const afterLines = splitLines(c.after.source);
  const againAdd = ["", ...splitLines(c.again.source)];

  const [hBefore, hPain, hAfter, hAgain] = await Promise.all([
    highlightLines(baseLines.join("\n"), lang),
    highlightLines(painText.join("\n"), lang),
    highlightLines(afterLines.join("\n"), lang),
    highlightLines([...afterLines, ...againAdd].join("\n"), lang),
  ]);

  const before: PreparedCode = {
    file: c.before.file,
    roles: c.before.roles,
    lines: hBefore.map((toks, i) => ({ n: i + 1, kind: "base", toks })),
  };
  const pain: PreparedCode = {
    file: c.before.file,
    roles: c.before.roles,
    lines: hPain.map((toks, i) => ({ ...painKinds[i], toks })),
  };
  const after: PreparedCode = {
    file: c.after.file,
    roles: c.after.roles,
    lines: hAfter.map((toks, i) => ({ n: i + 1, kind: "base", toks })),
  };
  const first = afterLines.length + 2;
  const again: PreparedCode = {
    file: [...new Set([...c.after.file.split(" · "), c.again.file])].join(" · "),
    roles: { ...c.after.roles, change: [first, afterLines.length + againAdd.length] },
    lines: hAgain.map((toks, i) => ({ n: i + 1, kind: i + 1 >= first ? "new" : "base", toks })),
  };
  return { before, pain, after, again, cost: c.cost, lens: c.lens };
}

export async function prepareCode(meta: TopicMeta): Promise<Record<Lang, PreparedLang>> {
  const entries = await Promise.all(
    LANGS.filter((l) => meta.languages.includes(l)).map(async (l) => [l, await prepareLang(l, meta.code[l])] as const),
  );
  return Object.fromEntries(entries) as Record<Lang, PreparedLang>;
}
