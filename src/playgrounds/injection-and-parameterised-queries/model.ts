// Injection playground: one customer-search endpoint, three ways to build its SQL, one fake database.
//
// After this, the reader can answer: why does a parameterised query stop injection when escaping
// does not? (Concatenation lets input characters become SQL syntax: a quote closes the string and
// the rest is code. A parameter is sent separately, after the statement has been parsed, so it can
// only ever be a value. Escaping protects the one context it was written for and nothing else, and
// identifiers such as a sort column cannot be parameters, so they need an allow-list.)
//
// The reader types the q and sort parameters of GET /api/customers, picks a build, and sends it.
// The model builds the SQL text exactly as that build would, marks every input character as data
// (inside a string literal) or code (anything else), parses and runs it on a tiny in-memory SQL
// engine, and keeps the damage: rows from other tenants, password hashes read, rows deleted,
// tables dropped. Everything is simulated; nothing here talks to a real database.

/* ================================================================ the fake database */

export type Val = string | number | boolean | null;
export type Row = Record<string, Val>;
export interface Table { columns: string[]; rows: Row[] }
export type Db = Record<string, Table>;

export const TENANT = 42;

export function seedDb(): Db {
  const c = (id: number, tenant_id: number, name: string, email: string, created_at: string): Row => ({ id, tenant_id, name, email, created_at });
  return {
    customers: {
      columns: ["id", "tenant_id", "name", "email", "created_at"],
      rows: [
        c(1, 42, "Ada Lovelace", "ada@northwind.test", "2024-01-09"),
        c(2, 42, "Grace Hopper", "grace@northwind.test", "2024-03-14"),
        c(3, 42, "Siobhan O'Brien", "siobhan@northwind.test", "2024-06-02"),
        c(4, 42, "Alan Turing", "alan@northwind.test", "2025-02-21"),
        c(5, 42, "Katherine Johnson", "kj@northwind.test", "2025-07-30"),
        c(6, 7, "Dmitri Volkov", "dmitri@rival.test", "2024-02-11"),
        c(7, 7, "Mei Tanaka", "mei@rival.test", "2024-11-05"),
        c(8, 7, "Lars Eriksen", "lars@rival.test", "2025-04-18"),
      ],
    },
    users: {
      columns: ["id", "email", "password_hash", "role"],
      rows: [
        { id: 1, email: "admin@ourapp.test", password_hash: "$2b$12$Qm7v…", role: "superuser" },
        { id: 2, email: "support@ourapp.test", password_hash: "$2b$12$k1Zt…", role: "support" },
        { id: 3, email: "owner@northwind.test", password_hash: "$2b$12$8sPe…", role: "tenant_admin" },
      ],
    },
  };
}

/* ================================================================ tokenizer */

export type TokKind = "kw" | "ident" | "str" | "num" | "param" | "op" | "comment" | "ws" | "bad";
export interface Tok { kind: TokKind; text: string; start: number; end: number; value?: Val }

const KEYWORDS = new Set(["SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "LIKE", "ILIKE", "ORDER", "BY", "ASC", "DESC", "UNION", "ALL",
  "DELETE", "DROP", "TABLE", "UPDATE", "SET", "TRUE", "FALSE", "NULL", "LIMIT", "INSERT", "INTO", "VALUES"]);

export class SqlError extends Error {}

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const start = i;
    if (/\s/.test(ch)) { while (i < sql.length && /\s/.test(sql[i])) i++; out.push({ kind: "ws", text: sql.slice(start, i), start, end: i }); continue; }
    if (sql.startsWith("--", i)) { while (i < sql.length && sql[i] !== "\n") i++; out.push({ kind: "comment", text: sql.slice(start, i), start, end: i }); continue; }
    if (sql.startsWith("/*", i)) {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
      out.push({ kind: "comment", text: sql.slice(start, i), start, end: i });
      continue;
    }
    if (ch === "'") {
      let v = "";
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'") { if (sql[i + 1] === "'") { v += "'"; i += 2; continue; } i++; closed = true; break; }
        v += sql[i++];
      }
      if (!closed) { out.push({ kind: "bad", text: sql.slice(start), start, end: sql.length }); return out; }
      out.push({ kind: "str", text: sql.slice(start, i), start, end: i, value: v });
      continue;
    }
    if (/[0-9]/.test(ch)) { while (i < sql.length && /[0-9.]/.test(sql[i])) i++; out.push({ kind: "num", text: sql.slice(start, i), start, end: i, value: Number(sql.slice(start, i)) }); continue; }
    if (ch === "$" && /[0-9]/.test(sql[i + 1] ?? "")) { i++; while (i < sql.length && /[0-9]/.test(sql[i])) i++; out.push({ kind: "param", text: sql.slice(start, i), start, end: i }); continue; }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      const t = sql.slice(start, i);
      out.push({ kind: KEYWORDS.has(t.toUpperCase()) ? "kw" : "ident", text: t, start, end: i });
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (["<>", "!=", "<=", ">=", "||"].includes(two)) { i += 2; out.push({ kind: "op", text: two, start, end: i }); continue; }
    if ("=<>(),;*.".includes(ch)) { i++; out.push({ kind: "op", text: ch, start, end: i }); continue; }
    i++;
    out.push({ kind: "op", text: ch, start, end: i });
  }
  return out;
}

/* ================================================================ parser */

export type Expr =
  | { k: "lit"; v: Val }
  | { k: "col"; name: string }
  | { k: "param"; n: number }
  | { k: "bin"; op: string; a: Expr; b: Expr }
  | { k: "not"; e: Expr };

export interface SelectCore { cols: { e: Expr; name: string }[] | "*"; table: string; where: Expr | null }
export type Stmt =
  | { k: "select"; parts: SelectCore[]; order: { col: string; desc: boolean } | null }
  | { k: "delete"; table: string; where: Expr | null }
  | { k: "drop"; table: string }
  | { k: "update"; table: string; col: string; e: Expr; where: Expr | null };

export function parse(sql: string): Stmt[] {
  const toks = tokenize(sql).filter((t) => t.kind !== "ws" && t.kind !== "comment");
  const bad = toks.find((t) => t.kind === "bad");
  if (bad) throw new SqlError(`unterminated quoted string at or near "${bad.text.slice(0, 40)}"`);
  let p = 0;
  const peek = () => toks[p];
  const near = () => (peek() ? `syntax error at or near "${peek().text}"` : "syntax error at end of input");
  const isKw = (w: string) => peek()?.kind === "kw" && peek().text.toUpperCase() === w;
  const isOp = (o: string) => peek()?.kind === "op" && peek().text === o;
  const kw = (w: string) => { if (!isKw(w)) throw new SqlError(near()); p++; };
  const ident = () => { const t = peek(); if (!t || t.kind !== "ident") throw new SqlError(near()); p++; return t.text.toLowerCase(); };

  function primary(): Expr {
    const t = peek();
    if (!t) throw new SqlError(near());
    if (t.kind === "str" || t.kind === "num") { p++; return { k: "lit", v: t.value ?? null }; }
    if (t.kind === "param") { p++; return { k: "param", n: Number(t.text.slice(1)) }; }
    if (t.kind === "ident") { p++; return { k: "col", name: t.text.toLowerCase() }; }
    if (isKw("TRUE")) { p++; return { k: "lit", v: true }; }
    if (isKw("FALSE")) { p++; return { k: "lit", v: false }; }
    if (isKw("NULL")) { p++; return { k: "lit", v: null }; }
    if (isOp("(")) { p++; const e = expr(); if (!isOp(")")) throw new SqlError(near()); p++; return e; }
    throw new SqlError(near());
  }
  function concat(): Expr { let e = primary(); while (isOp("||")) { p++; e = { k: "bin", op: "||", a: e, b: primary() }; } return e; }
  function cmp(): Expr {
    const a = concat();
    const t = peek();
    if (t && t.kind === "op" && ["=", "<>", "!=", "<", ">", "<=", ">="].includes(t.text)) { p++; return { k: "bin", op: t.text, a, b: concat() }; }
    if (isKw("LIKE") || isKw("ILIKE")) { const op = peek().text.toUpperCase(); p++; return { k: "bin", op, a, b: concat() }; }
    return a;
  }
  function not(): Expr { if (isKw("NOT")) { p++; return { k: "not", e: not() }; } return cmp(); }
  function and(): Expr { let e = not(); while (isKw("AND")) { p++; e = { k: "bin", op: "AND", a: e, b: not() }; } return e; }
  function expr(): Expr { let e = and(); while (isKw("OR")) { p++; e = { k: "bin", op: "OR", a: e, b: and() }; } return e; }

  function core(): SelectCore {
    kw("SELECT");
    let cols: SelectCore["cols"];
    if (isOp("*")) { p++; cols = "*"; } else {
      cols = [];
      do {
        const e = expr();
        cols.push({ e, name: e.k === "col" ? e.name : "?column?" });
      } while (isOp(",") && ++p);
    }
    kw("FROM");
    const table = ident();
    let where: Expr | null = null;
    if (isKw("WHERE")) { p++; where = expr(); }
    return { cols, table, where };
  }

  function stmt(): Stmt | null {
    if (!peek() || isOp(";")) return null;
    if (isKw("SELECT")) {
      const parts = [core()];
      while (isKw("UNION")) { p++; if (isKw("ALL")) p++; parts.push(core()); }
      let order: { col: string; desc: boolean } | null = null;
      if (isKw("ORDER")) {
        p++; kw("BY");
        const col = ident();
        let desc = false;
        if (isKw("DESC")) { p++; desc = true; } else if (isKw("ASC")) p++;
        order = { col, desc };
      }
      return { k: "select", parts, order };
    }
    if (isKw("DELETE")) { p++; kw("FROM"); const table = ident(); let where: Expr | null = null; if (isKw("WHERE")) { p++; where = expr(); } return { k: "delete", table, where }; }
    if (isKw("DROP")) { p++; kw("TABLE"); return { k: "drop", table: ident() }; }
    if (isKw("UPDATE")) {
      p++; const table = ident(); kw("SET"); const col = ident();
      if (!isOp("=")) throw new SqlError(near());
      p++; const e = expr(); let where: Expr | null = null;
      if (isKw("WHERE")) { p++; where = expr(); }
      return { k: "update", table, col, e, where };
    }
    throw new SqlError(near());
  }

  const out: Stmt[] = [];
  while (p < toks.length) {
    const s = stmt();
    if (s) out.push(s);
    if (p < toks.length) { if (!isOp(";")) throw new SqlError(near()); p++; }
  }
  return out;
}

/* ================================================================ evaluator */

const like = (s: string, pat: string, ci: boolean) =>
  new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$", ci ? "is" : "s").test(s);

function evalExpr(e: Expr, row: Row, params: Val[], table: Table | null): Val {
  switch (e.k) {
    case "lit": return e.v;
    case "param": return params[e.n - 1] ?? null;
    case "col":
      if (!table || !table.columns.includes(e.name)) throw new SqlError(`column "${e.name}" does not exist`);
      return row[e.name];
    case "not": return !truthy(evalExpr(e.e, row, params, table));
    case "bin": {
      if (e.op === "AND") return truthy(evalExpr(e.a, row, params, table)) && truthy(evalExpr(e.b, row, params, table));
      if (e.op === "OR") return truthy(evalExpr(e.a, row, params, table)) || truthy(evalExpr(e.b, row, params, table));
      const a = evalExpr(e.a, row, params, table), b = evalExpr(e.b, row, params, table);
      if (e.op === "||") return a === null || b === null ? null : String(a) + String(b);
      if (a === null || b === null) return null;
      if (e.op === "LIKE" || e.op === "ILIKE") return like(String(a), String(b), e.op === "ILIKE");
      const [x, y] = typeof a === "number" || typeof b === "number" ? [Number(a), Number(b)] : [String(a), String(b)];
      switch (e.op) {
        case "=": return x === y;
        case "<>": case "!=": return x !== y;
        case "<": return x < y;
        case ">": return x > y;
        case "<=": return x <= y;
        case ">=": return x >= y;
      }
      return null;
    }
  }
}
const truthy = (v: Val) => v === true || (typeof v === "number" && v !== 0);

function tableOf(db: Db, name: string): Table {
  const t = db[name];
  if (!t) throw new SqlError(`relation "${name}" does not exist`);
  return t;
}

export interface Effects { statements: number; deleted: number; updated: number; dropped: string[]; tablesRead: string[] }
export interface Exec { db: Db; columns: string[]; rows: Row[]; effects: Effects }

/** Run a parsed script. Returns the first SELECT's rows (what the endpoint sends back) and the new database. */
export function execute(db0: Db, stmts: Stmt[], params: Val[]): Exec {
  let db: Db = db0;
  const effects: Effects = { statements: stmts.length, deleted: 0, updated: 0, dropped: [], tablesRead: [] };
  let first: { columns: string[]; rows: Row[] } | null = null;
  for (const s of stmts) {
    if (s.k === "select") {
      let columns: string[] = [];
      let rows: Row[] = [];
      s.parts.forEach((c, i) => {
        const t = tableOf(db, c.table);
        if (!effects.tablesRead.includes(c.table)) effects.tablesRead.push(c.table);
        const cols = c.cols === "*" ? t.columns.map((name) => ({ e: { k: "col", name } as Expr, name })) : c.cols;
        if (i === 0) columns = cols.map((x) => x.name);
        else if (cols.length !== columns.length) throw new SqlError("each UNION query must have the same number of columns");
        for (const r of t.rows) {
          if (c.where && !truthy(evalExpr(c.where, r, params, t))) continue;
          const out: Row = {};
          cols.forEach((x, j) => { out[columns[j]] = evalExpr(x.e, r, params, t); });
          rows.push(out);
        }
      });
      if (s.order) {
        const { col, desc } = s.order;
        if (!columns.includes(col)) {
          // ORDER BY may name a column of the (single) table that is not selected.
          const t = s.parts.length === 1 ? tableOf(db, s.parts[0].table) : null;
          if (!t || !t.columns.includes(col)) throw new SqlError(`column "${col}" does not exist`);
          const t0 = t;
          const keyed = t0.rows.filter((r) => !s.parts[0].where || truthy(evalExpr(s.parts[0].where, r, params, t0)));
          const keys = keyed.map((r) => r[col]);
          const idx = rows.map((_, i) => i).sort((a, b) => cmpVal(keys[a], keys[b]) * (desc ? -1 : 1));
          rows = idx.map((i) => rows[i]);
        } else rows = [...rows].sort((a, b) => cmpVal(a[col], b[col]) * (desc ? -1 : 1));
      }
      if (!first) first = { columns, rows };
    } else if (s.k === "delete") {
      const t = tableOf(db, s.table);
      const keep = t.rows.filter((r) => s.where && !truthy(evalExpr(s.where, r, params, t)));
      effects.deleted += t.rows.length - keep.length;
      db = { ...db, [s.table]: { ...t, rows: keep } };
    } else if (s.k === "drop") {
      tableOf(db, s.table);
      const { [s.table]: _gone, ...rest } = db;
      db = rest;
      effects.dropped.push(s.table);
    } else {
      const t = tableOf(db, s.table);
      if (!t.columns.includes(s.col)) throw new SqlError(`column "${s.col}" of relation "${s.table}" does not exist`);
      const rows = t.rows.map((r) => {
        if (s.where && !truthy(evalExpr(s.where, r, params, t))) return r;
        effects.updated++;
        return { ...r, [s.col]: evalExpr(s.e, r, params, t) };
      });
      db = { ...db, [s.table]: { ...t, rows } };
    }
  }
  return { db, columns: first?.columns ?? [], rows: first?.rows ?? [], effects };
}

function cmpVal(a: Val, b: Val): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
}

/* ================================================================ the endpoint, three builds */

export type Build = "concat" | "escape" | "param";
export const BUILDS: Build[] = ["concat", "escape", "param"];
export const BUILD_NAME: Record<Build, string> = { concat: "String concatenation", escape: "Concatenation + escaped quotes", param: "Parameters + allow-list" };

export const SORTS: Record<string, string> = { name: "name", email: "email", created: "created_at" };

/** Which characters of the SQL text came from the request. */
export interface Seg { text: string; from: "template" | "q" | "sort" }
/** How each input character was read by the parser. */
export type Role = "data" | "code" | "comment" | "ident";
export interface Piece { text: string; from: Seg["from"]; role: Role | "template"; disabled: boolean }

export interface Request { q: string; sort: string }
export interface Built { segs: Seg[]; sql: string; params: Val[]; rejected: string | null }

export function build(b: Build, r: Request): Built {
  if (b === "param") {
    const col = Object.prototype.hasOwnProperty.call(SORTS, r.sort) ? SORTS[r.sort] : null;
    if (!col) return { segs: [], sql: "", params: [], rejected: `unknown sort "${r.sort}"` };
    const sql = `SELECT id, name, email FROM customers WHERE tenant_id = $1 AND name ILIKE '%' || $2 || '%' ORDER BY ${col}`;
    return { segs: [{ text: sql, from: "template" }], sql, params: [TENANT, r.q], rejected: null };
  }
  const q = b === "escape" ? r.q.replaceAll("'", "''") : r.q;
  const segs: Seg[] = [
    { text: `SELECT id, name, email FROM customers WHERE tenant_id = ${TENANT} AND name ILIKE '%`, from: "template" },
    { text: q, from: "q" },
    { text: "%' ORDER BY ", from: "template" },
    { text: r.sort, from: "sort" },
  ];
  return { segs, sql: segs.map((s) => s.text).join(""), params: [], rejected: null };
}

/** Split the SQL into pieces by origin, and label each input piece by the token it landed in. */
export function annotate(segs: Seg[]): Piece[] {
  const sql = segs.map((s) => s.text).join("");
  const toks = tokenize(sql);
  const roleAt = (i: number): { role: Role } => {
    const t = toks.find((x) => i >= x.start && i < x.end);
    if (!t) return { role: "code" };
    return { role: t.kind === "str" ? "data" : t.kind === "comment" ? "comment" : "code" };
  };
  // Template text that a comment swallowed is disabled: the request switched it off.
  // A sort value that is exactly one identifier is the column name the template expects.
  let sortStart = 0;
  for (const s of segs) { if (s.from === "sort") break; sortStart += s.text.length; }
  const sortSeg = segs.find((s) => s.from === "sort");
  const sortEnd = sortStart + (sortSeg?.text.length ?? 0);
  const inSort = toks.filter((t) => t.end > sortStart && t.start < sortEnd && t.kind !== "ws");
  const plainIdent = inSort.length === 1 && inSort[0].kind === "ident" && inSort[0].start >= sortStart && inSort[0].end <= sortEnd;
  const out: Piece[] = [];
  let pos = 0;
  for (const s of segs) {
    for (let k = 0; k < s.text.length; k++) {
      const i = pos + k;
      const { role } = roleAt(i);
      const r: Piece["role"] = s.from === "template" ? "template" : s.from === "sort" && plainIdent && role === "code" ? "ident" : role;
      const disabled = s.from === "template" && role === "comment";
      const last = out[out.length - 1];
      if (last && last.from === s.from && last.role === r && last.disabled === disabled) last.text += sql[i];
      else out.push({ text: sql[i], from: s.from, role: r, disabled });
    }
    pos += s.text.length;
  }
  return out;
}

export interface Run {
  n: number;
  build: Build;
  req: Request;
  sql: string;
  params: Val[];
  pieces: Piece[];
  status: 200 | 400 | 500;
  error: string | null;
  columns: string[];
  rows: Row[];
  effects: Effects;
  /** Input characters the parser read as SQL syntax (not inside a string literal). */
  codeChars: number;
  otherTenantRows: number;
  secretsRead: number;
}

export function send(db: Db, b: Build, req: Request, n = 0): { run: Run; db: Db } {
  const blt = build(b, req);
  const empty: Effects = { statements: 0, deleted: 0, updated: 0, dropped: [], tablesRead: [] };
  const base = { n, build: b, req, sql: blt.sql, params: blt.params, columns: [] as string[], rows: [] as Row[], effects: empty, otherTenantRows: 0, secretsRead: 0 };
  if (blt.rejected) return { run: { ...base, pieces: [], status: 400, error: blt.rejected, codeChars: 0 }, db };
  const pieces = annotate(blt.segs);
  const codeChars = pieces.filter((p) => p.from !== "template" && (p.role === "code" || p.role === "comment")).reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0);
  try {
    const stmts = parse(blt.sql);
    const ex = execute(db, stmts, blt.params);
    const ids = new Set(db.customers?.rows.filter((r) => r.tenant_id !== TENANT).map((r) => `${r.id}|${r.name}`) ?? []);
    const otherTenantRows = ex.rows.filter((r) => ids.has(`${r.id}|${r.name}`)).length;
    const hashes = new Set(db.users?.rows.map((r) => String(r.password_hash)) ?? []);
    const secretsRead = ex.rows.filter((r) => Object.values(r).some((v) => typeof v === "string" && hashes.has(v))).length;
    return { run: { ...base, pieces, status: 200, error: null, columns: ex.columns, rows: ex.rows, effects: ex.effects, codeChars, otherTenantRows, secretsRead }, db: ex.db };
  } catch (e) {
    if (!(e instanceof SqlError)) throw e;
    return { run: { ...base, pieces, status: 500, error: `ERROR: ${e.message}`, codeChars }, db };
  }
}

/* ================================================================ state */

export interface Probe { label: string; q?: string; sort?: string; note: string }
/** Textbook probe strings, for this fake database only. */
export const PROBES: Probe[] = [
  { label: "O'Brien", q: "O'Brien", note: "A real customer's name with an apostrophe." },
  { label: "' OR 1=1 --", q: "' OR 1=1 --", note: "Close the string, add a condition that is always true, comment out the rest." },
  { label: "' UNION SELECT … users --", q: "' UNION SELECT id, email, password_hash FROM users --", note: "Append a second query that reads another table." },
  { label: "'; DELETE FROM customers --", q: "'; DELETE FROM customers --", note: "End the statement and start a new one." },
  { label: "sort=name; DROP TABLE customers", sort: "name; DROP TABLE customers --", note: "No quote needed: the sort column is not inside a string." },
];

export interface State {
  build: Build;
  q: string;
  sort: string;
  db: Db;
  runs: Run[];
}

export type Action =
  | { type: "build"; build: Build }
  | { type: "q"; q: string }
  | { type: "sort"; sort: string }
  | { type: "probe"; index: number }
  | { type: "send" }
  | { type: "restore" }
  | { type: "reset" };

export function init(): State {
  return { build: "concat", q: "ada", sort: "name", db: seedDb(), runs: [] };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "restore": return { ...st, db: seedDb() };
    case "build": return { ...st, build: a.build };
    case "q": return { ...st, q: a.q.slice(0, 200) };
    case "sort": return { ...st, sort: a.sort.slice(0, 100) };
    case "probe": {
      const p = PROBES[a.index];
      if (!p) return st;
      return { ...st, q: p.q ?? "", sort: p.sort ?? "name" };
    }
    case "send": {
      const n = (st.runs[st.runs.length - 1]?.n ?? 0) + 1;
      const { run, db } = send(st.db, st.build, { q: st.q, sort: st.sort }, n);
      return { ...st, db, runs: [...st.runs, run].slice(-12) };
    }
  }
}

/** The same request against the other builds, on the current database, with nothing kept. */
export function counterfactual(st: State): Run[] {
  return BUILDS.map((b) => send(st.db, b, { q: st.q, sort: st.sort }).run);
}

/* ================================================================ totals and challenges */

export interface Totals { codeChars: number; otherTenantRows: number; secretsRead: number; deleted: number; dropped: number; errors: number; extraStatements: number }
export function totals(runs: Run[], b?: Build): Totals {
  const rs = b ? runs.filter((r) => r.build === b) : runs;
  return {
    codeChars: rs.reduce((n, r) => n + r.codeChars, 0),
    otherTenantRows: rs.reduce((n, r) => n + r.otherTenantRows, 0),
    secretsRead: rs.reduce((n, r) => n + r.secretsRead, 0),
    deleted: rs.reduce((n, r) => n + r.effects.deleted, 0),
    dropped: rs.reduce((n, r) => n + r.effects.dropped.length, 0),
    errors: rs.filter((r) => r.status === 500).length,
    extraStatements: rs.reduce((n, r) => n + Math.max(0, r.effects.statements - 1), 0),
  };
}

export interface Goals { otherTenant: boolean; secrets: boolean; destroy: boolean; escapeBroken: boolean; obrien: boolean }
export function goals(runs: Run[]): Goals {
  return {
    otherTenant: runs.some((r) => r.otherTenantRows > 0),
    secrets: runs.some((r) => r.secretsRead > 0),
    destroy: runs.some((r) => r.effects.deleted > 0 || r.effects.dropped.length > 0),
    escapeBroken: runs.some((r) => r.build === "escape" && r.codeChars > 0 && r.status === 200),
    obrien: runs.some((r) => r.build === "param" && r.rows.some((x) => x.name === "Siobhan O'Brien")),
  };
}
