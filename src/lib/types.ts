// Shared types for topic content. Everything a lesson shows comes from one file:
// content/<track>/<topic>.mdx (YAML frontmatter for structure, MDX body for prose).

export const LANGS = ["go", "python", "typescript", "rust"] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_LABEL: Record<Lang, string> = { go: "Go", python: "Python", typescript: "TypeScript", rust: "Rust" };
export const LANG_SHORT: Record<Lang, string> = { go: "Go", python: "Python", typescript: "TS", rust: "Rust" };

export const DEPTHS = [1, 2, 3] as const;
export type Depth = (typeof DEPTHS)[number];
export const DEPTH_LABEL: Record<Depth, string> = { 1: "Overview", 2: "Engineer", 3: "Deep" };
export const DEPTH_NAMES = ["overview", "engineer", "deep"] as const;
export type DepthName = (typeof DEPTH_NAMES)[number];
export const depthName = (d: Depth): DepthName => DEPTH_NAMES[d - 1];
export const depthNumber = (n: DepthName): Depth => (DEPTH_NAMES.indexOf(n) + 1) as Depth;

/** The fixed lesson anatomy. Every topic has these eight steps, in this order. */
export const STEP_KEYS = ["concept", "problem", "pain", "morph", "walk", "again", "play", "lens", "check"] as const;
export type StepKey = (typeof STEP_KEYS)[number];
export const STEP_LABEL: Record<StepKey, string> = {
  concept: "Concept",
  problem: "Problem",
  pain: "Pain",
  morph: "Morph",
  walk: "How it works",
  again: "Same request again",
  play: "Try it",
  lens: "Language lens",
  check: "Check",
};

/** A string, or one string per language. */
export type PerLang<T = string> = T | Partial<Record<Lang, T>>;

export interface Box { x: number; y: number; w: number; h: number; title: PerLang; sub?: PerLang }

export interface DiagramNode {
  id: string;
  kind: "client" | "context" | "strategy" | "concrete";
  /** both: always shown. after: fades in during the morph. change: the new variant (ghost in Pain, new in Same request again). */
  appears?: "both" | "after" | "change";
  before: Box;
  after: Box;
}

export interface DiagramEdge { from: string; to: string; label?: string; kind?: "uses" | "implements" }

export interface DiagramSpec { width: number; height: number; nodes: DiagramNode[]; edges: DiagramEdge[] }

export type Range = [number, number];

export interface ChangeOp { after?: number; line?: number; add?: string[]; replace?: string }

export interface CodeVariant {
  file: string;
  source: string;
  /** Map from diagram node id or walk role to a line range. */
  roles: Record<string, Range>;
}

export interface LangCode {
  before: CodeVariant & { change: ChangeOp[] };
  after: CodeVariant;
  again: { file: string; source: string };
  cost: { before: { text: string; value: number }; after: { text: string; value: number } };
  lens: { need: 1 | 2 | 3 | 4; needLabel: string; note: string; seenIn: string };
}

export interface WalkStep { text: PerLang; nodes: string[]; edges: string[]; role: string }

export interface CheckOption { text: string; correct?: boolean; why: string }

export interface ReferenceInfo {
  roles: { role: string; example: PerLang; job: string }[];
  useWhen: string[];
  avoidWhen: string[];
  tradeoffs: string[];
  lookalikes: { name: string; how: string }[];
}

export interface Scenario { try: string; notice: string }
export interface PlaygroundRef { model: string; scenarios: Scenario[] }
export interface Check { question: string; options: CheckOption[] }

export interface TopicMeta {
  /** "<track>/<slug>", derived from the file path. */
  id: string;
  title: string;
  slug: string;
  track: string;
  group: string;
  order: number;
  summary: string;
  intent: string;
  changeRequest: string;
  languages: Lang[];
  diagram: DiagramSpec;
  code: Record<Lang, LangCode>;
  walk: WalkStep[];
  /** Roadmap metadata. */
  prerequisites: string[];
  skills: string[];
  depths: DepthName[];
  /** One check per depth the lesson covers. Passing it marks the lesson done at that depth. */
  checks: Partial<Record<DepthName, Check>>;
  playground: PlaygroundRef;
  reference: ReferenceInfo;
  glossary?: string[];
}

export interface Track { id: string; title: string; summary: string; status: "live" | "planned"; groups?: string[] }

/** A planned lesson from content/outlines/<track>.yaml (shown as coming soon until written). */
export interface OutlineLesson { id: string; title: string; summary?: string; prerequisites: string[]; skills: string[] }

export interface SkillEntry { id: string; title: string; summary?: string }

/** A goal profile: the skills a role needs, each at a depth, with the reason. */
export interface RoadmapProfile {
  id: string;
  title: string;
  summary: string;
  goals: { skill: string; depth: DepthName; why: string }[];
}

export interface GlossaryEntry { id: string; term: string; short: string; long?: string }

/* ---------- prepared data sent to the client ---------- */

export interface Tok { c: string; v?: string }
export interface CodeLine { n: number | null; kind: "base" | "add" | "mod" | "new"; toks: Tok[] }
export interface PreparedCode {
  file: string;
  lines: CodeLine[];
  roles: Record<string, Range>;
}
export interface PreparedLang {
  before: PreparedCode;
  pain: PreparedCode;
  after: PreparedCode;
  again: PreparedCode;
  cost: LangCode["cost"];
  lens: LangCode["lens"];
}

export function pick<T>(v: PerLang<T> | undefined, lang: Lang): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object" && !Array.isArray(v)) {
    const m = v as Partial<Record<Lang, T>>;
    if (LANGS.some((l) => l in m)) return m[lang] ?? m.go ?? (Object.values(m)[0] as T);
  }
  return v as T;
}
