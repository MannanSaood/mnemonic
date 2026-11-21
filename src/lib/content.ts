import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import YAML from "yaml";
import {
  LANGS,
  STEP_KEYS,
  type CodeLine,
  type GlossaryEntry,
  type Lang,
  type LangCode,
  type PreparedCode,
  type PreparedLang,
  type StepKey,
  type TopicMeta,
  type Track,
} from "./types";
import { highlightLines } from "./highlight";

const CONTENT = path.join(process.cwd(), "content");

export interface StepSource { key: StepKey; title: string; mdx: string }
export interface Topic { meta: TopicMeta; steps: StepSource[]; reference: string }

/* ---------------- tracks and glossary ---------------- */

export function getTracks(): Track[] {
  return YAML.parse(fs.readFileSync(path.join(CONTENT, "tracks.yaml"), "utf8")) as Track[];
}

let glossaryCache: Record<string, GlossaryEntry> | null = null;
export function getGlossary(): Record<string, GlossaryEntry> {
  if (glossaryCache) return glossaryCache;
  const list = YAML.parse(fs.readFileSync(path.join(CONTENT, "glossary.yaml"), "utf8")) as GlossaryEntry[];
  glossaryCache = Object.fromEntries(list.map((g) => [g.id, g]));
  return glossaryCache;
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

  validate(file, meta, steps);
  return { meta, steps, reference };
}

function validate(file: string, meta: TopicMeta, steps: StepSource[]) {
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
  if (!meta.check?.options?.some((o) => o.correct)) fail(rel, "check needs one option with correct: true");
}

export function listTopics(): TopicMeta[] {
  const out: TopicMeta[] = [];
  for (const track of fs.readdirSync(CONTENT, { withFileTypes: true })) {
    if (!track.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(CONTENT, track.name))) {
      if (f.endsWith(".mdx")) out.push(parseTopic(path.join(CONTENT, track.name, f)).meta);
    }
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
