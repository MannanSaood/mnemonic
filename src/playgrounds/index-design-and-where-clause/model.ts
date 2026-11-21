// Index design playground: one orders table, two composite indexes, one WHERE clause.
//
// After this, the reader can answer: for a given WHERE clause, which part of a composite index
// can narrow the scan (equality on leading columns, then one range), which conditions are only
// filters, and when does the planner give up on the index and read the whole table?
//
// The table has ROWS rows stored in insertion order (so created_at is physically sorted). An index
// is the rows sorted by its key tuple. A WHERE clause is parsed into per-column predicates and
// split three ways, following the PostgreSQL docs on multicolumn indexes:
//   access  equality on leading columns, plus a range on the first column without equality:
//           these set where the scan starts and stops.
//   index filter  conditions on later index columns: checked in the index, saving table visits.
//   table filter  conditions on columns the index does not have, or columns hidden in a function.
// The planner compares a sequential scan with an index scan using PostgreSQL's default cost
// constants (seq_page_cost 1, random_page_cost 4, cpu_tuple_cost 0.01, cpu_index_tuple_cost 0.005)
// and the bitmap-heap-scan page cost formula, with exact row counts instead of estimates.
//
// Plain state + pure functions. The table is generated once from a fixed seed.

export type Col = "tenant_id" | "status" | "created_at" | "total_cents";
export const COLS: Col[] = ["tenant_id", "status", "created_at", "total_cents"];
export const STATUSES = ["new", "paid", "shipped", "cancelled"] as const;
export type Engine = "pg17" | "pg18";
export type Challenge = "rangeFirst" | "tight" | "function" | "giveUp" | "skip";

export const ROWS = 100_000;
export const ROWS_PER_PAGE = 50;
export const TABLE_PAGES = ROWS / ROWS_PER_PAGE;
export const ENTRIES_PER_LEAF = 200;
export const HEIGHT = 3;
export const BINS = 100;
const SEQ = 1, RANDOM = 4, CPU_TUPLE = 0.01, CPU_INDEX = 0.005;
/** Day number 1..365 of the year 2026. */
export const YEAR = 2026;

/* ---------------- the table ---------------- */

export interface Table { tenant: Uint8Array; status: Uint8Array; day: Uint16Array; total: Int32Array }

function mulberry(seed: number) {
  let s = seed;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let table: Table | null = null;
/** 100,000 orders over one year, inserted in time order. 50 tenants; status is skewed: most orders end up shipped. */
export function getTable(): Table {
  if (table) return table;
  const r = mulberry(7);
  const t: Table = { tenant: new Uint8Array(ROWS), status: new Uint8Array(ROWS), day: new Uint16Array(ROWS), total: new Int32Array(ROWS) };
  for (let i = 0; i < ROWS; i++) {
    t.day[i] = 1 + Math.floor((i * 365) / ROWS);
    t.tenant[i] = 1 + Math.floor(r() * 50);
    const s = r();
    // recent orders are more often still new or paid
    const recent = t.day[i] > 350;
    t.status[i] = recent ? (s < 0.3 ? 0 : s < 0.6 ? 1 : s < 0.97 ? 2 : 3) : (s < 0.01 ? 0 : s < 0.05 ? 1 : s < 0.95 ? 2 : 3);
    t.total[i] = 100 + Math.floor(r() * r() * 50_000);
  }
  table = t;
  return t;
}

function value(t: Table, col: Col, i: number): number {
  switch (col) {
    case "tenant_id": return t.tenant[i];
    case "status": return t.status[i];
    case "created_at": return t.day[i];
    case "total_cents": return t.total[i];
  }
}

const orders = new Map<string, Int32Array>();
/** Row ids in index order for an index on `cols` (ties broken by row id, like a heap TID). */
export function indexOrder(cols: Col[]): Int32Array {
  const k = cols.join(",");
  const hit = orders.get(k);
  if (hit) return hit;
  const t = getTable();
  const ids = Array.from({ length: ROWS }, (_, i) => i);
  ids.sort((a, b) => {
    for (const c of cols) { const d = value(t, c, a) - value(t, c, b); if (d) return d; }
    return a - b;
  });
  const out = Int32Array.from(ids);
  orders.set(k, out);
  return out;
}

/* ---------------- parsing a WHERE clause ---------------- */

export interface Pred {
  col: Col;
  /** Set of allowed values for equality / IN, else null. */
  eq: number[] | null;
  lo: number;
  hi: number;
  /** The column is wrapped in a function or expression, so a plain index on it cannot be used. */
  wrapped: string | null;
  text: string;
}

export interface Parsed { preds: Pred[]; error: string | null }

export function dayOf(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || Number(m[1]) !== YEAR) return null;
  const d = Date.UTC(YEAR, Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d)) return null;
  const n = Math.round((d - Date.UTC(YEAR, 0, 1)) / 86_400_000) + 1;
  return n >= 1 && n <= 366 ? n : null;
}

export function isoOf(day: number): string {
  return new Date(Date.UTC(YEAR, 0, day)).toISOString().slice(0, 10);
}

function parseValue(col: Col, raw: string): number | string {
  const s = raw.trim();
  const q = /^'(.*)'$/.exec(s);
  if (col === "status") {
    if (!q) return `status values are quoted strings, like 'new'`;
    const i = STATUSES.indexOf(q[1].toLowerCase() as (typeof STATUSES)[number]);
    return i < 0 ? `status is one of ${STATUSES.map((x) => `'${x}'`).join(", ")}` : i;
  }
  if (col === "created_at") {
    const d = q ? dayOf(q[1]) : null;
    return d ?? `created_at values are dates in ${YEAR}, like '${YEAR}-11-01'`;
  }
  if (!/^-?\d+$/.test(s)) return `${col} values are whole numbers`;
  return Number(s);
}

const FUNCS = ["lower", "upper", "date", "abs", "coalesce", "date_trunc"];

/** Parse `a = 1 AND b >= '2026-01-01' AND c IN (1, 2) AND d BETWEEN 1 AND 9 AND lower(status) = 'new'`. */
export function parseWhere(src: string): Parsed {
  const text = src.trim().replace(/;$/, "").replace(/^where\s+/i, "");
  if (!text) return { preds: [], error: null };
  // Protect BETWEEN x AND y from the AND split.
  const guarded = text.replace(/\bbetween\s+(.+?)\s+and\s+/gi, (_m, a) => `BETWEEN ${a} ~~ `);
  const terms = guarded.split(/\s+and\s+/i);
  const preds: Pred[] = [];
  for (const term0 of terms) {
    const term = term0.replace(/ ~~ /, " AND ").trim();
    const m = /^([a-z_]+\s*\(\s*[a-z_]+\s*(?:,[^)]*)?\)|[a-z_]+(?:\s*[+-]\s*\d+)?)\s*(=|<=|>=|<|>|\bin\b|\bbetween\b)\s*(.+)$/i.exec(term);
    if (!m) return { preds, error: `Could not read "${term}". Use column = value, <, <=, >, >=, IN (...) or BETWEEN ... AND ..., joined by AND.` };
    const lhs = m[1].replace(/\s+/g, "");
    let col = lhs as Col;
    let wrapped: string | null = null;
    const fm = /^([a-z_]+)\(([a-z_]+)(?:,.*)?\)$/i.exec(lhs);
    const em = /^([a-z_]+)[+-]\d+$/i.exec(lhs);
    if (fm) {
      if (!FUNCS.includes(fm[1].toLowerCase())) return { preds, error: `Unknown function ${fm[1]}(). Try lower(), upper() or date().` };
      col = fm[2].toLowerCase() as Col;
      wrapped = `${fm[1].toLowerCase()}(${col})`;
    } else if (em) {
      col = em[1].toLowerCase() as Col;
      wrapped = lhs;
    }
    col = col.toLowerCase() as Col;
    if (!COLS.includes(col)) return { preds, error: `orders has no column "${col}". Columns: ${COLS.join(", ")}.` };
    const op = m[2].toLowerCase();
    const rhs = m[3].trim();
    let eq: number[] | null = null, lo = -Infinity, hi = Infinity;
    const one = (raw: string) => {
      const v = parseValue(col, raw);
      if (typeof v === "string") throw new Error(v);
      // an expression like total_cents + 0 compares the shifted value
      if (em) { const k = Number(lhs.slice(em[1].length).replace(/\s/g, "")); return v - k; }
      return v;
    };
    try {
      if (op === "in") {
        const inner = /^\((.*)\)$/.exec(rhs);
        if (!inner) throw new Error("IN needs a list in parentheses, like IN (3, 7)");
        eq = inner[1].split(",").map(one);
      } else if (op === "between") {
        const parts = rhs.split(/\s+and\s+/i);
        if (parts.length !== 2) throw new Error("BETWEEN needs two values: BETWEEN a AND b");
        lo = one(parts[0]); hi = one(parts[1]);
      } else {
        const v = one(rhs);
        if (col === "status" && op !== "=") throw new Error("compare status with = or IN");
        if (op === "=") eq = [v];
        else if (op === "<") hi = v - 1;
        else if (op === "<=") hi = v;
        else if (op === ">") lo = v + 1;
        else lo = v;
      }
    } catch (e) {
      return { preds, error: (e as Error).message };
    }
    preds.push({ col, eq, lo, hi, wrapped, text: term });
  }
  return { preds, error: null };
}

/* ---------------- planning and running ---------------- */

export type Use = "access" | "skip" | "index filter" | "table filter";
export interface PredUse { pred: Pred; use: Use }

export interface Run {
  index: Col[];
  uses: PredUse[];
  /** Columns that limit the scanned range, in index order. */
  accessCols: Col[];
  /** Leading index column the scan skips over (PostgreSQL 18 skip scan), if used. */
  skipCol: Col | null;
  descents: number;
  entriesScanned: number;
  leafPages: number;
  fetched: number;
  heapPages: number;
  returned: number;
  costIndex: number;
  costSeq: number;
  plan: "index" | "seq";
  /** Rows the chosen plan examines: table rows fetched, or every row for a seq scan. */
  examined: number;
  pagesRead: number;
  /** Per bin of the index (in key order): entries scanned, entries returned. */
  bins: { scanned: number; returned: number }[];
  /** First index column value at each bin start, for labels. */
  binLabels: string[];
}

function test(p: Pred, v: number): boolean {
  if (p.eq) return p.eq.includes(v) && v >= p.lo && v <= p.hi;
  return v >= p.lo && v <= p.hi;
}

function distinctValues(col: Col): number {
  return col === "tenant_id" ? 50 : col === "status" ? 4 : col === "created_at" ? 365 : 50_000;
}

export function showValue(col: Col, v: number): string {
  if (col === "status") return STATUSES[v] ?? String(v);
  if (col === "created_at") return isoOf(v).slice(5);
  return String(v);
}

/** Classify each predicate against an index, as the PostgreSQL docs on multicolumn indexes describe. */
export function classify(index: Col[], preds: Pred[], allowSkip: boolean): { uses: PredUse[]; accessCols: Col[]; skipCol: Col | null } {
  const usable = (c: Col) => preds.filter((p) => p.col === c && !p.wrapped);
  const accessCols: Col[] = [];
  let skipCol: Col | null = null;
  for (let i = 0; i < index.length; i++) {
    const ps = usable(index[i]);
    if (!ps.length) {
      // PostgreSQL 18 can skip a leading column with no condition when a later column has one.
      if (i === 0 && allowSkip && index.length > 1 && usable(index[1]).length) { skipCol = index[0]; continue; }
      break;
    }
    accessCols.push(index[i]);
    if (!ps.some((p) => p.eq)) break; // a range: columns after it can only filter
  }
  const uses = preds.map((pred): PredUse => {
    if (!pred.wrapped && accessCols.includes(pred.col)) return { pred, use: "access" };
    if (!pred.wrapped && index.includes(pred.col)) return { pred, use: "index filter" };
    return { pred, use: "table filter" };
  });
  return { uses, accessCols, skipCol };
}

export function runQuery(index: Col[], preds: Pred[], engine: Engine): Run {
  const t = getTable();
  const evaluate = (allowSkip: boolean) => {
    const c = classify(index, preds, allowSkip);
    const acc = c.uses.filter((u) => u.use === "access").map((u) => u.pred);
    const idxf = c.uses.filter((u) => u.use === "index filter").map((u) => u.pred);
    const all = preds;
    const order = indexOrder(index.length ? index : ["created_at"]);
    const bins = Array.from({ length: BINS }, () => ({ scanned: 0, returned: 0 }));
    const pages = new Set<number>();
    let scanned = 0, fetched = 0, returned = 0;
    for (let k = 0; k < ROWS; k++) {
      const i = order[k];
      if (!index.length) break;
      if (!acc.every((p) => test(p, value(t, p.col, i)))) continue;
      scanned++;
      const b = bins[Math.floor((k * BINS) / ROWS)];
      b.scanned++;
      if (!idxf.every((p) => test(p, value(t, p.col, i)))) continue;
      fetched++;
      pages.add(Math.floor(i / ROWS_PER_PAGE));
      if (all.every((p) => test(p, value(t, p.col, i)))) { returned++; b.returned++; }
    }
    // One descent per value of a skipped column, and per value in an IN list on an access column.
    let descents = c.skipCol ? distinctValues(c.skipCol) : 1;
    for (const p of acc) if (p.eq && p.eq.length > 1) descents *= p.eq.length;
    const heapPages = pages.size;
    const leafPages = Math.ceil(scanned / ENTRIES_PER_LEAF) + (descents > 1 ? descents - 1 : 0);
    const heapPerPage = RANDOM - (RANDOM - SEQ) * Math.sqrt(Math.min(1, heapPages / TABLE_PAGES));
    const usableIndex = index.length > 0 && acc.length > 0;
    const costIndex = usableIndex
      ? descents * HEIGHT * RANDOM + leafPages * SEQ + scanned * CPU_INDEX + heapPages * heapPerPage + fetched * CPU_TUPLE
      : Infinity;
    return { c, scanned, fetched, returned, heapPages, leafPages, descents, costIndex, bins };
  };
  let r = evaluate(false);
  if (engine === "pg18") {
    const s = evaluate(true);
    if (s.c.skipCol && s.costIndex < r.costIndex) r = s;
  }
  // The real answer, independent of the index.
  let returnedAll = 0;
  for (let i = 0; i < ROWS; i++) if (preds.every((p) => test(p, value(t, p.col, i)))) returnedAll++;
  const costSeq = TABLE_PAGES * SEQ + ROWS * CPU_TUPLE + ROWS * preds.length * 0.0025;
  const plan = r.costIndex < costSeq ? "index" : "seq";
  const order = indexOrder(index.length ? index : ["created_at"]);
  const lead = index[0] ?? "created_at";
  const binLabels = Array.from({ length: BINS }, (_, b) => showValue(lead, value(t, lead, order[Math.floor((b * ROWS) / BINS)])));
  return {
    index, uses: r.c.uses, accessCols: r.c.accessCols, skipCol: r.c.skipCol, descents: r.descents,
    entriesScanned: r.scanned, leafPages: r.leafPages, fetched: r.fetched, heapPages: r.heapPages,
    returned: returnedAll, costIndex: r.costIndex, costSeq, plan,
    examined: plan === "index" ? r.fetched : ROWS,
    pagesRead: plan === "index" ? r.descents * HEIGHT + r.leafPages + r.heapPages : TABLE_PAGES,
    bins: r.bins, binLabels,
  };
}

/* ---------------- state ---------------- */

export interface Tried { query: string; runs: [Run, Run] }

export interface State {
  indexes: [Col[], Col[]];
  draft: string;
  query: string;
  parsed: Parsed;
  engine: Engine;
  runs: [Run, Run] | null;
  history: Tried[];
  done: Challenge[];
}

export type Action =
  | { type: "draft"; text: string }
  | { type: "run"; text?: string }
  | { type: "addCol"; lane: 0 | 1; col: Col }
  | { type: "removeCol"; lane: 0 | 1; at: number }
  | { type: "moveCol"; lane: 0 | 1; at: number; dir: -1 | 1 }
  | { type: "setIndex"; lane: 0 | 1; cols: Col[] }
  | { type: "engine"; engine: Engine }
  | { type: "reset" };

export const PRESETS = [
  `tenant_id = 7 AND created_at >= '${YEAR}-12-01'`,
  `created_at >= '${YEAR}-12-01' AND tenant_id = 7`,
  `created_at >= '${YEAR}-12-01'`,
  `tenant_id = 7`,
  `tenant_id = 7 AND status = 'new'`,
  `status = 'shipped'`,
  `date(created_at) = '${YEAR}-12-24' AND tenant_id = 7`,
  `tenant_id + 0 = 7 AND created_at >= '${YEAR}-12-01'`,
];

function challenges(st: State): Challenge[] {
  const got = new Set(st.done);
  if (st.runs) for (const r of st.runs) {
    const firstIsRange = r.accessCols.length === 1 && r.uses.some((u) => u.use === "access" && !u.pred.eq) && r.uses.some((u) => u.use === "index filter");
    if (firstIsRange && r.returned > 0 && r.entriesScanned >= 20 * r.returned) got.add("rangeFirst");
    if (r.plan === "index" && r.accessCols.length >= 2 && r.returned > 0 && r.entriesScanned === r.returned) got.add("tight");
    if (r.plan === "seq" && r.uses.some((u) => u.pred.wrapped && u.pred.col === r.index[0])) got.add("function");
    if (r.plan === "seq" && r.accessCols.length >= 1 && !r.uses.some((u) => u.pred.wrapped)) got.add("giveUp");
    if (r.plan === "index" && r.skipCol) got.add("skip");
  }
  return (["rangeFirst", "tight", "function", "giveUp", "skip"] as Challenge[]).filter((c) => got.has(c));
}

function execute(st: State, text: string): State {
  const parsed = parseWhere(text);
  if (parsed.error || !parsed.preds.length) return { ...st, draft: text, parsed: parsed.error ? parsed : { preds: [], error: "Write at least one condition." } };
  const runs: [Run, Run] = [runQuery(st.indexes[0], parsed.preds, st.engine), runQuery(st.indexes[1], parsed.preds, st.engine)];
  const history = [{ query: text, runs }, ...st.history.filter((h) => h.query !== text)].slice(0, 6) as Tried[];
  const next = { ...st, draft: text, query: text, parsed, runs, history };
  return { ...next, done: challenges(next) };
}

/** After an index or engine change, rerun the current query so the numbers stay true. */
const rerun = (st: State): State => (st.query ? execute({ ...st, history: st.history }, st.query) : st);

export function init(): State {
  return {
    indexes: [["created_at", "tenant_id"], ["tenant_id", "created_at"]],
    draft: PRESETS[0], query: "", parsed: { preds: [], error: null }, engine: "pg17", runs: null, history: [], done: [],
  };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "draft": return { ...st, draft: a.text };
    case "run": return execute(st, a.text ?? st.draft);
    case "engine": return rerun({ ...st, engine: a.engine });
    case "setIndex": case "addCol": case "removeCol": case "moveCol": {
      const indexes = [...st.indexes] as [Col[], Col[]];
      const cur = [...indexes[a.lane]];
      if (a.type === "setIndex") indexes[a.lane] = a.cols;
      else if (a.type === "addCol") { if (!cur.includes(a.col) && cur.length < 4) indexes[a.lane] = [...cur, a.col]; }
      else if (a.type === "removeCol") { cur.splice(a.at, 1); indexes[a.lane] = cur; }
      else {
        const j = a.at + a.dir;
        if (j >= 0 && j < cur.length) { [cur[a.at], cur[j]] = [cur[j], cur[a.at]]; indexes[a.lane] = cur; }
      }
      return rerun({ ...st, indexes });
    }
  }
}

export const indexName = (cols: Col[]) => (cols.length ? `(${cols.join(", ")})` : "(no index)");
