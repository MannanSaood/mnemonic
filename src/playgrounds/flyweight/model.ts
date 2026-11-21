// Flyweight playground: a log store holding millions of lines. Every line has nine fields. Most of
// them repeat across lines (service, host, region, the log call's template), some never repeat
// (timestamp, arguments).
//
// After this, the reader can answer: what decides how much memory a flyweight saves? (The number
// of distinct shared states, not the number of objects. Share a field that varies per line and the
// pool grows to one entry per line, costing more than no sharing at all. And whatever is shared
// must never change, or editing one line edits thousands.)
//
// The reader moves fields between "per line" (extrinsic) and "shared" (intrinsic), picks how many
// lines to load, and watches the memory of both designs. Plain state + pure functions, tested.

export type Field = "level" | "service" | "host" | "region" | "version" | "template" | "timestamp" | "traceId" | "args";
export const FIELDS: Field[] = ["level", "service", "host", "region", "version", "template", "timestamp", "traceId", "args"];

export interface FieldInfo { label: string; example: string; bytes: number; note: string }
/** Bytes as a typical 64-bit runtime stores them: a 16-byte string header plus the characters, or a raw value. */
export const INFO: Record<Field, FieldInfo> = {
  level: { label: "level", example: "ERROR", bytes: 16 + 5, note: "5 values" },
  service: { label: "service", example: "checkout-api", bytes: 16 + 12, note: "40 services" },
  host: { label: "host", example: "ip-10-4-23-117.eu-west-1", bytes: 16 + 24, note: "15 hosts per service, each in one region" },
  region: { label: "region", example: "eu-west-1", bytes: 16 + 9, note: "6 regions" },
  version: { label: "version", example: "checkout@1.42.7", bytes: 16 + 16, note: "3 live versions per service" },
  template: { label: "template", example: "payment %s declined: %s", bytes: 16 + 60, note: "8 log calls per service, each with a fixed level" },
  timestamp: { label: "timestamp", example: "1732186112.042", bytes: 8, note: "different on every line" },
  traceId: { label: "trace id", example: "4bf92f3577b34da6", bytes: 16, note: "about 20 lines per request" },
  args: { label: "args", example: '["ord_81x", "insufficient funds"]', bytes: 16 + 40, note: "different on every line" },
};

export const HEADER = 16;   // object header
export const POINTER = 8;   // a line's reference to its shared object
export const POOL_ENTRY = 48; // the factory's map entry per shared object
export const SERVICES = 40, HOSTS = 15, TEMPLATES = 8, VERSIONS = 3, LEVELS = 5, REGIONS = 6, LINES_PER_TRACE = 20;

export const LINE_OPTIONS = [10_000, 100_000, 1_000_000, 10_000_000] as const;
export type Lines = (typeof LINE_OPTIONS)[number];

export interface State {
  shared: Field[];
  lines: Lines;
  /** The break-it experiment: the reader changed one line's level, and this many lines changed. */
  edit: { field: Field; changed: number } | null;
  /** Whether the reader has ever seen one edit land on many lines (for the challenge list). */
  sawMutation: boolean;
  /** Splits the reader has measured, for the comparison table. */
  tried: { shared: Field[]; lines: Lines; bytes: number; naive: number }[];
}

export type Action =
  | { type: "toggle"; field: Field }
  | { type: "lines"; lines: Lines }
  | { type: "editLine" }
  | { type: "measure" }
  | { type: "reset" };

export function init(): State {
  return { shared: [], lines: 10_000_000, edit: null, sawMutation: false, tried: [] };
}

/* ---------------- the memory model ---------------- */

/** How many different shared objects exist when lines share exactly these fields. */
export function combos(shared: Field[], lines: number): number {
  const has = (f: Field) => shared.includes(f);
  if (has("timestamp") || has("args")) return lines;
  let base: number;
  const perService = has("service") || has("host") || has("template") || has("version");
  if (!perService) base = (has("level") ? LEVELS : 1) * (has("region") ? REGIONS : 1);
  else base = SERVICES * (has("host") ? HOSTS : has("region") ? REGIONS : 1) * (has("template") ? TEMPLATES : has("level") ? LEVELS : 1) * (has("version") ? VERSIONS : 1);
  if (has("traceId")) base *= lines / LINES_PER_TRACE;
  // Expected number of distinct values seen in `lines` draws from `base` possibilities.
  return Math.max(1, Math.round(base * (1 - Math.exp(-lines / base))));
}

const sum = (fs: Field[]) => fs.reduce((a, f) => a + INFO[f].bytes, 0);

export interface Memory { naive: number; lineBytes: number; pool: number; poolObjects: number; total: number }

export function memory(shared: Field[], lines: number): Memory {
  const perLine = FIELDS.filter((f) => !shared.includes(f));
  const naive = lines * (HEADER + sum(FIELDS));
  if (!shared.length) return { naive, lineBytes: naive, pool: 0, poolObjects: 0, total: naive };
  const poolObjects = combos(shared, lines);
  const lineBytes = lines * (HEADER + POINTER + sum(perLine));
  const pool = poolObjects * (HEADER + sum(shared) + POOL_ENTRY);
  return { naive, lineBytes, pool, poolObjects, total: lineBytes + pool };
}

/** The best split: share every field that repeats, keep the ones that never repeat on the line. */
export const BEST: Field[] = ["level", "service", "host", "region", "version", "template"];

export interface Goals { third: boolean; worse: boolean; best: boolean; mutated: boolean }
export function goals(st: State): Goals {
  const best = memory(BEST, 10_000_000).total;
  return {
    third: st.tried.some((t) => t.lines === 10_000_000 && t.bytes <= t.naive * 0.35),
    worse: st.tried.some((t) => t.bytes > t.naive),
    best: st.tried.some((t) => t.lines === 10_000_000 && t.bytes <= best),
    mutated: st.sawMutation,
  };
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "toggle": {
      const shared = st.shared.includes(a.field) ? st.shared.filter((f) => f !== a.field) : FIELDS.filter((f) => f === a.field || st.shared.includes(f));
      return { ...st, shared, edit: null };
    }
    case "lines":
      return { ...st, lines: a.lines, edit: null };
    case "editLine": {
      // An on-call engineer fixes line 42's level from ERROR to WARN. If level lives in a shared
      // object, that write lands on every line pointing at the same object.
      if (!st.shared.includes("level")) return { ...st, edit: { field: "level", changed: 1 } };
      const changed = Math.max(1, Math.round(st.lines / combos(st.shared, st.lines)));
      return { ...st, edit: { field: "level", changed }, sawMutation: st.sawMutation || changed > 1 };
    }
    case "measure": {
      const m = memory(st.shared, st.lines);
      return { ...st, tried: [...st.tried, { shared: [...st.shared], lines: st.lines, bytes: m.total, naive: m.naive }] };
    }
  }
}
