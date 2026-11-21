// Isolation playground: two transactions on a timeline, against a tiny multiversion database.
//
// After this, the reader can answer: which anomalies does each isolation level let through
// (read skew, lost update, write skew), and how does PostgreSQL stop them at Repeatable Read and
// Serializable? (By failing one transaction with SQLSTATE 40001, which the application must retry.)
//
// The rules follow the PostgreSQL documentation (chapter "Transaction Isolation"):
//   Read Committed  every statement sees what was committed when it started. An UPDATE or a
//                   SELECT ... FOR UPDATE that finds a row locked by another transaction waits;
//                   if that one commits, it works on the new version of the row.
//   Repeatable Read the transaction sees one snapshot, taken at its first statement. Updating or
//                   locking a row changed by a transaction that committed after that snapshot fails
//                   with "could not serialize access due to concurrent update" (40001).
//   Serializable    the same, plus Serializable Snapshot Isolation: when two concurrent
//                   transactions each read something the other wrote, the second to commit fails
//                   with "could not serialize access due to read/write dependencies" (40001).
// Locks are per row, two transactions waiting on each other is a deadlock (40P01).
//
// Plain state + a pure step function, so every interleaving can be enumerated and tested.

export type Level = "rc" | "rr" | "ser";
export type Workload = "stock" | "oncall" | "report";
export type Mode = "plain" | "forUpdate" | "atomic";
export type Tx = 0 | 1;
export type Status = "idle" | "active" | "waiting" | "committed" | "aborted";
export type Anomaly = "lost update" | "write skew" | "read skew";
export type Challenge = "lost" | "skewRR" | "readSkew" | "blocked40001" | "ssi" | "fixedRC";

export const LEVELS: { value: Level; label: string }[] = [
  { value: "rc", label: "Read committed" },
  { value: "rr", label: "Repeatable read" },
  { value: "ser", label: "Serializable" },
];

interface Version { value: number; writer: Tx | null; commitTime: number }

export interface TxState {
  pc: number;
  status: Status;
  attempt: number;
  /** Clock time of the first statement (the snapshot for RR and Serializable). */
  start: number | null;
  snapshot: Record<string, number> | null;
  vars: Record<string, number>;
  writes: Record<string, number>;
  locks: string[];
  reads: string[];
  /** Rows this transaction wrote, kept after commit for the serializable check. */
  wrote: string[];
  waitingFor: string | null;
  commitTime: number | null;
  error: string | null;
}

export interface Event { t: number; tx: Tx; attempt: number; sql: string; result: string; kind: "ok" | "wait" | "error" | "commit" | "note"; /** Committed values after this event. */ db: string }

export interface State {
  workload: Workload;
  level: Level;
  mode: Mode;
  clock: number;
  db: Record<string, Version>;
  txs: [TxState, TxState];
  events: Event[];
  /** Outcome of the finished history, if both transactions are done. */
  outcome: Outcome | null;
  /** Finished histories this session: anomalies, aborts. */
  stats: { histories: number; anomalies: number; aborts: number; retries: number };
  done: Challenge[];
}

export interface Outcome { anomaly: Anomaly | null; aborted: number; text: string }

export type Action =
  | { type: "step"; tx: Tx }
  | { type: "retry"; tx: Tx }
  | { type: "workload"; workload: Workload }
  | { type: "level"; level: Level }
  | { type: "mode"; mode: Mode }
  | { type: "restart" }
  | { type: "reset" };

/* ---------------- workloads ---------------- */

export const QTY: [number, number] = [3, 2];
export const NAMES: [string, string] = ["alice", "bob"];

function initialRows(w: Workload): Record<string, number> {
  if (w === "stock") return { stock: 10 };
  if (w === "oncall") return { alice: 1, bob: 1 };
  return { a: 100, b: 50 };
}

export function modesFor(w: Workload): Mode[] {
  return w === "stock" ? ["plain", "forUpdate", "atomic"] : ["plain", "forUpdate"];
}

export const WORKLOADS: { value: Workload; label: string; t1: string; t2: string; rule: string }[] = [
  { value: "stock", label: "Two checkouts", t1: "sells 3", t2: "sells 2", rule: "stock ends at 10 minus every committed sale" },
  { value: "oncall", label: "On-call rota", t1: "Alice goes off call", t2: "Bob goes off call", rule: "at least one engineer stays on call" },
  { value: "report", label: "Balance report", t1: "sums two accounts", t2: "moves 30 from a to b", rule: "the report sees a + b = 150" },
];

type Op =
  | { kind: "read"; rows: string[]; lock: boolean; sql: string; into: (vals: Record<string, number>, v: Record<string, number>) => void; show: (v: Record<string, number>) => string }
  | { kind: "write"; row: string; sql: string; value: (current: number, v: Record<string, number>) => number; skip?: (v: Record<string, number>) => string | null }
  | { kind: "commit" };

/** The script of a transaction: what it runs at step pc. */
export function script(w: Workload, mode: Mode, tx: Tx): Op[] {
  const fu = mode === "forUpdate" ? " FOR UPDATE" : "";
  if (w === "stock") {
    const q = QTY[tx];
    if (mode === "atomic") {
      return [
        { kind: "write", row: "stock", sql: `UPDATE items SET stock = stock - ${q}`, value: (cur) => cur - q },
        { kind: "commit" },
      ];
    }
    return [
      { kind: "read", rows: ["stock"], lock: mode === "forUpdate", sql: `SELECT stock FROM items${fu}`, into: (vals, v) => { v.stock = vals.stock; }, show: (v) => `stock = ${v.stock}` },
      { kind: "write", row: "stock", sql: `UPDATE items SET stock = :stock - ${q}`, value: (_cur, v) => v.stock - q },
      { kind: "commit" },
    ];
  }
  if (w === "oncall") {
    const me = NAMES[tx];
    return [
      { kind: "read", rows: ["alice", "bob"], lock: mode === "forUpdate", sql: mode === "forUpdate" ? `SELECT name FROM rota WHERE on_call FOR UPDATE` : `SELECT count(*) FROM rota WHERE on_call`, into: (vals, v) => { v.onCall = vals.alice + vals.bob; }, show: (v) => `${v.onCall} on call` },
      { kind: "write", row: me, sql: `UPDATE rota SET on_call = false WHERE name = '${me}'`, value: () => 0, skip: (v) => (v.onCall < 2 ? `only ${v.onCall} on call: ${me} stays` : null) },
      { kind: "commit" },
    ];
  }
  if (tx === 0) {
    return [
      { kind: "read", rows: ["a"], lock: mode === "forUpdate", sql: `SELECT balance FROM accounts WHERE id = 'a'${fu}`, into: (vals, v) => { v.a = vals.a; }, show: (v) => `a = ${v.a}` },
      { kind: "read", rows: ["b"], lock: mode === "forUpdate", sql: `SELECT balance FROM accounts WHERE id = 'b'${fu}`, into: (vals, v) => { v.b = vals.b; }, show: (v) => `b = ${v.b}, total ${v.a + v.b}` },
      { kind: "commit" },
    ];
  }
  return [
    { kind: "write", row: "a", sql: `UPDATE accounts SET balance = balance - 30 WHERE id = 'a'`, value: (cur) => cur - 30 },
    { kind: "write", row: "b", sql: `UPDATE accounts SET balance = balance + 30 WHERE id = 'b'`, value: (cur) => cur + 30 },
    { kind: "commit" },
  ];
}

export function nextSql(st: State, tx: Tx): string | null {
  const t = st.txs[tx];
  if (t.status === "committed" || t.status === "aborted") return null;
  const op = script(st.workload, st.mode, tx)[t.pc];
  if (op.kind === "commit") return "COMMIT";
  return op.sql.replace(":stock", t.vars.stock === undefined ? ":stock" : String(t.vars.stock));
}

/* ---------------- the database ---------------- */

const freshTx = (attempt = 1): TxState => ({
  pc: 0, status: "idle", attempt, start: null, snapshot: null, vars: {}, writes: {}, locks: [], reads: [], wrote: [], waitingFor: null, commitTime: null, error: null,
});

function fresh(workload: Workload, level: Level, mode: Mode, stats?: State["stats"], done?: Challenge[]): State {
  const rows = initialRows(workload);
  const db: Record<string, Version> = {};
  for (const k in rows) db[k] = { value: rows[k], writer: null, commitTime: 0 };
  return {
    workload, level, mode, clock: 0, db, txs: [freshTx(), freshTx()], events: [], outcome: null,
    stats: stats ?? { histories: 0, anomalies: 0, aborts: 0, retries: 0 }, done: done ?? [],
  };
}

export function init(): State {
  return fresh("stock", "rc", "plain");
}

const other = (tx: Tx): Tx => (tx === 0 ? 1 : 0);
const isLive = (t: TxState) => t.status === "active" || t.status === "waiting";

/** What a statement of `tx` sees for `row` right now. */
function visible(st: State, tx: Tx, row: string): number {
  const t = st.txs[tx];
  if (row in t.writes) return t.writes[row];
  if (st.level === "rc" || !t.snapshot) return st.db[row].value;
  return t.snapshot[row];
}

/** Changed by a transaction that committed after this transaction's snapshot? */
function changedSinceSnapshot(st: State, tx: Tx, row: string): boolean {
  const t = st.txs[tx];
  const v = st.db[row];
  return st.level !== "rc" && t.start !== null && v.writer !== null && v.writer !== tx && v.commitTime > t.start;
}

function lockedByOther(st: State, tx: Tx, rows: string[]): string | null {
  const o = st.txs[other(tx)];
  if (!isLive(o)) return null;
  return rows.find((r) => o.locks.includes(r)) ?? null;
}

/** Committed values, as a short line: "stock 10" or "alice 1 · bob 1". */
export function committedText(st: State): string {
  return Object.entries(st.db).map(([k, v]) => `${k} ${v.value}`).join(" · ");
}

function setTx(st: State, tx: Tx, patch: Partial<TxState>): State {
  const txs = [...st.txs] as [TxState, TxState];
  txs[tx] = { ...txs[tx], ...patch };
  return { ...st, txs };
}

function log(st: State, tx: Tx, sql: string, result: string, kind: Event["kind"]): State {
  return { ...st, events: [...st.events, { t: st.clock, tx, attempt: st.txs[tx].attempt, sql, result, kind, db: committedText(st) }] };
}

/** Release a finished transaction's locks: anyone waiting on them may run again. */
function wake(st: State, finished: Tx): State {
  const o = other(finished);
  if (st.txs[o].status === "waiting") return setTx(st, o, { status: "active", waitingFor: null });
  return st;
}

function abort(st: State, tx: Tx, sql: string, code: string, msg: string): State {
  let s = setTx(st, tx, { status: "aborted", error: `${code} ${msg}`, writes: {}, locks: [], waitingFor: null });
  s = log(s, tx, sql, `ERROR ${code}: ${msg}`, "error");
  return finish(wake(s, tx));
}

const SER_UPDATE = "could not serialize access due to concurrent update";
const SER_RW = "could not serialize access due to read/write dependencies among transactions";

/** Try to take row locks for tx. Returns the new state and whether tx may proceed. */
function acquire(st: State, tx: Tx, rows: string[], sql: string): [State, boolean] {
  const held = lockedByOther(st, tx, rows);
  if (held) {
    const o = st.txs[other(tx)];
    if (o.status === "waiting" && o.waitingFor !== null && st.txs[tx].locks.includes(o.waitingFor)) {
      return [abort(st, tx, sql, "40P01", "deadlock detected"), false];
    }
    let s = setTx(st, tx, { status: "waiting", waitingFor: held });
    s = log(s, tx, sql, `waits: T${other(tx) + 1} holds the lock on ${held}`, "wait");
    return [s, false];
  }
  // Repeatable read and serializable may not lock a row changed after their snapshot.
  const changed = rows.find((r) => changedSinceSnapshot(st, tx, r));
  if (changed) return [abort(st, tx, sql, "40001", SER_UPDATE), false];
  const locks = [...new Set([...st.txs[tx].locks, ...rows])];
  return [setTx(st, tx, { locks }), true];
}

function runStep(st0: State, tx: Tx): State {
  let st = st0;
  const t = st.txs[tx];
  if (t.status === "committed" || t.status === "aborted" || t.status === "waiting") return st;
  const op = script(st.workload, st.mode, tx)[t.pc];
  st = { ...st, clock: st.clock + 1 };
  // The first statement starts the transaction and, for RR and Serializable, takes the snapshot.
  if (t.start === null) {
    const snapshot: Record<string, number> = {};
    for (const k in st.db) snapshot[k] = st.db[k].value;
    st = setTx(st, tx, { status: "active", start: st.clock, snapshot });
  } else if (t.status === "idle") {
    st = setTx(st, tx, { status: "active" });
  }

  if (op.kind === "read") {
    if (op.lock) {
      const [s, ok] = acquire(st, tx, op.rows, op.sql);
      if (!ok) return s;
      st = s;
    }
    const vals: Record<string, number> = {};
    for (const r of op.rows) vals[r] = visible(st, tx, r);
    const vars = { ...st.txs[tx].vars };
    op.into(vals, vars);
    st = setTx(st, tx, { vars, pc: t.pc + 1, reads: [...new Set([...st.txs[tx].reads, ...op.rows])] });
    return log(st, tx, op.sql, op.show(vars), "ok");
  }

  if (op.kind === "write") {
    const skip = op.skip?.(st.txs[tx].vars) ?? null;
    if (skip) {
      st = setTx(st, tx, { pc: t.pc + 1 });
      return log(st, tx, "-- no UPDATE", skip, "note");
    }
    const sql = op.sql.replace(":stock", String(st.txs[tx].vars.stock ?? ""));
    const [s, ok] = acquire(st, tx, [op.row], sql);
    if (!ok) return s;
    st = s;
    // Read committed: work on the newest committed version (the WHERE clause is re-checked on it).
    const current = visible(st, tx, op.row);
    const nv = op.value(current, st.txs[tx].vars);
    st = setTx(st, tx, { writes: { ...st.txs[tx].writes, [op.row]: nv }, pc: t.pc + 1 });
    return log(st, tx, sql, `${op.row} = ${nv} (not committed yet)`, "ok");
  }

  // COMMIT. Serializable checks for a read/write dependency cycle with a concurrent transaction.
  if (st.level === "ser") {
    const o = st.txs[other(tx)];
    const me = st.txs[tx];
    const oWrites = o.status === "committed" ? o.wrote : Object.keys(o.writes);
    const concurrent = o.start !== null && (isLive(o) || (o.status === "committed" && (o.commitTime ?? 0) > (me.start ?? 0)));
    const out = me.reads.some((r) => oWrites.includes(r)); // I read what they wrote: me -rw-> them
    const inn = o.reads.some((r) => r in me.writes); // they read what I wrote: them -rw-> me
    if (concurrent && out && inn && o.status === "committed") return abort(st, tx, "COMMIT", "40001", SER_RW);
  }
  const db = { ...st.db };
  for (const [row, value] of Object.entries(st.txs[tx].writes)) db[row] = { value, writer: tx, commitTime: st.clock };
  st = { ...st, db };
  st = setTx(st, tx, { status: "committed", commitTime: st.clock, locks: [], wrote: Object.keys(st.txs[tx].writes) });
  st = log(st, tx, "COMMIT", Object.keys(st.txs[tx].writes).length ? "committed" : "committed (nothing written)", "commit");
  return finish(wake(st, tx));
}

/** When both transactions are done, judge the history. */
export function judge(st: State): Outcome | null {
  const [a, b] = st.txs;
  const doneTx = (t: TxState) => t.status === "committed" || t.status === "aborted";
  if (!doneTx(a) || !doneTx(b)) return null;
  const aborted = st.txs.filter((t) => t.status === "aborted").length;
  if (st.workload === "stock") {
    const expected = 10 - st.txs.reduce((k, t, i) => k + (t.status === "committed" ? QTY[i] : 0), 0);
    const got = st.db.stock.value;
    if (got !== expected) return { anomaly: "lost update", aborted, text: `stock is ${got}, but the committed sales leave ${expected}. One sale's write overwrote the other's.` };
    return { anomaly: null, aborted, text: `stock is ${got}, which matches every committed sale.` };
  }
  if (st.workload === "oncall") {
    const on = st.db.alice.value + st.db.bob.value;
    if (on === 0) return { anomaly: "write skew", aborted, text: "Nobody is on call. Each transaction checked that the other engineer was on call, then changed a different row." };
    return { anomaly: null, aborted, text: `${on} engineer${on === 1 ? " is" : "s are"} on call.` };
  }
  const t1 = st.txs[0];
  if (t1.status === "committed" && t1.vars.a !== undefined && t1.vars.b !== undefined && t1.vars.a + t1.vars.b !== 150) {
    return { anomaly: "read skew", aborted, text: `The report summed a = ${t1.vars.a} and b = ${t1.vars.b}: ${t1.vars.a + t1.vars.b}. It saw a before the transfer and b after it.` };
  }
  return { anomaly: null, aborted, text: t1.status === "committed" ? `The report saw a + b = ${t1.vars.a + t1.vars.b}.` : "The report did not commit." };
}

function finish(st: State): State {
  const outcome = judge(st);
  if (!outcome || st.outcome) return { ...st, outcome: outcome ?? st.outcome };
  const stats = {
    ...st.stats,
    histories: st.stats.histories + 1,
    anomalies: st.stats.anomalies + (outcome.anomaly ? 1 : 0),
    aborts: st.stats.aborts + outcome.aborted,
  };
  const next = { ...st, outcome, stats };
  return { ...next, done: challenges(next) };
}

/** Did both transactions overlap (each started before the other finished)? */
export function overlapped(st: State): boolean {
  const [a, b] = st.txs;
  if (a.start === null || b.start === null) return false;
  const end = (t: TxState) => t.commitTime ?? Infinity;
  const evEnd = (tx: Tx) => Math.max(...st.events.filter((e) => e.tx === tx && e.attempt === st.txs[tx].attempt).map((e) => e.t));
  const ea = Math.min(end(a), evEnd(0)), eb = Math.min(end(b), evEnd(1));
  return a.start < eb && b.start < ea;
}

function challenges(st: State): Challenge[] {
  const got = new Set(st.done);
  const o = st.outcome;
  if (o) {
    if (o.anomaly === "lost update") got.add("lost");
    if (o.anomaly === "write skew" && st.level === "rr") got.add("skewRR");
    if (o.anomaly === "read skew") got.add("readSkew");
    const errs = st.events.filter((e) => e.kind === "error");
    if (st.workload === "stock" && st.mode !== "atomic" && errs.some((e) => e.result.includes(SER_UPDATE))) got.add("blocked40001");
    if (st.workload === "oncall" && errs.some((e) => e.result.includes(SER_RW))) got.add("ssi");
    if (st.workload === "stock" && st.level === "rc" && st.mode !== "plain" && !o.anomaly && o.aborted === 0 && overlapped(st)) got.add("fixedRC");
  }
  return (["lost", "readSkew", "skewRR", "blocked40001", "ssi", "fixedRC"] as Challenge[]).filter((c) => got.has(c));
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "restart": return fresh(st.workload, st.level, st.mode, st.stats, st.done);
    case "workload": return fresh(a.workload, st.level, modesFor(a.workload).includes(st.mode) ? st.mode : "plain", st.stats, st.done);
    case "level": return fresh(st.workload, a.level, st.mode, st.stats, st.done);
    case "mode": return fresh(st.workload, st.level, a.mode, st.stats, st.done);
    case "step": return runStep(st, a.tx);
    case "retry": {
      const t = st.txs[a.tx];
      if (t.status !== "aborted") return st;
      let s = setTx(st, a.tx, freshTx(t.attempt + 1));
      s = { ...s, outcome: null, stats: { ...s.stats, retries: s.stats.retries + 1 } };
      return log(s, a.tx, "-- retry", `attempt ${t.attempt + 1}: run the whole transaction again`, "note");
    }
  }
}

/** Can this transaction take a step now? */
export const canStep = (st: State, tx: Tx) => st.txs[tx].status === "idle" || st.txs[tx].status === "active";

/* ---------------- every interleaving ---------------- */

export interface Tally { histories: number; correct: number; anomalies: number; aborted: number }

/** Run every order in which the two transactions' statements can interleave (no retries). */
export function tally(workload: Workload, level: Level, mode: Mode): Tally {
  const out: Tally = { histories: 0, correct: 0, anomalies: 0, aborted: 0 };
  const walk = (st: State) => {
    const moves = ([0, 1] as Tx[]).filter((tx) => canStep(st, tx));
    if (!moves.length) {
      const o = judge(st);
      if (!o) return; // cannot happen: a waiting transaction always has a live holder
      out.histories++;
      if (o.anomaly) out.anomalies++;
      else if (o.aborted) out.aborted++;
      else out.correct++;
      return;
    }
    for (const tx of moves) walk(runStep(st, tx));
  };
  walk(fresh(workload, level, mode));
  return out;
}

/** Drive a schedule like "1122" (T1, T1, T2, T2). */
export function play(st: State, schedule: string): State {
  return [...schedule].reduce((s, c) => step(s, { type: "step", tx: (Number(c) - 1) as Tx }), st);
}

/** Run whatever is left: T1 first, then T2, until both are done. */
export function drain(st: State): State {
  let s = st;
  for (let guard = 0; guard < 20; guard++) {
    const tx = ([0, 1] as Tx[]).find((t) => canStep(s, t));
    if (tx === undefined) return s;
    s = step(s, { type: "step", tx });
  }
  return s;
}
