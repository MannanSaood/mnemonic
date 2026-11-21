// Borrowing playground: a borrow checker over the timeline of one function.
//
// Purpose. After this, the reader can answer: "Will the compiler let me change this collection
// here, and what would go wrong if it did?" The rule is aliasing XOR mutability: at any line a
// value has either any number of shared borrows or one mutable borrow (and the owner cannot be
// written or moved while a borrow is alive). A borrow lasts from its creation to its LAST USE,
// not to the end of the block, so deleting or moving one use can make an error disappear.
//
// The reader edits borrows directly on the timeline: toggle uses, flip & and &mut, add a borrow.
// The checker draws each borrow as a span and reports E0499 / E0502 / E0505 like rustc. A
// counterfactual "run without the checker" shows what the rejected layout does at runtime: a
// push that reallocates leaves a dangling reference (as in C++), and removing from a list while
// iterating it skips elements (as in Python, Go's index loop and JavaScript's forEach).
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Kind = "shared" | "mut";
export type OwnerOp = "none" | "create" | "read" | "write" | "move";
export type ProgramId = "grow" | "evict" | "retain";
export const PROGRAMS: ProgramId[] = ["grow", "evict", "retain"];

export interface Row { code: string; op: OwnerOp; /** lanes may start or be used here */ usable: boolean }
export interface Lane {
  id: string;
  name: string;
  kind: Kind;
  start: number;
  /** Rows (1-based) after start where the reference is used. */
  uses: number[];
  /** The loop's iterator: its uses are fixed by the loop. */
  fixed?: boolean;
  /** Added by the reader. */
  added?: boolean;
}
export interface Program {
  id: ProgramId;
  title: string;
  owner: string;
  rows: Row[];
  lanes: Lane[];
  runtime: "realloc" | "skip" | "clean";
}

const r = (code: string, op: OwnerOp = "none", usable = op === "none"): Row => ({ code, op, usable });

export const PROGRAM: Record<ProgramId, Program> = {
  grow: {
    id: "grow", title: "Grow the pool", owner: "conns", runtime: "realloc",
    rows: [
      r("let mut conns = pool.take_idle(); // len 4, capacity 4", "create"),
      r("let oldest = &conns[0];"),
      r('log::debug!("oldest conn {}", oldest.id);'),
      r("conns.push(Conn::open(&cfg)?);", "write"),
      r("let newest = conns.last_mut().unwrap();"),
      r("newest.set_timeout(cfg.timeout);"),
      r("metrics.oldest_age(oldest.age());"),
      r("pool.give_back(conns);", "move"),
    ],
    lanes: [
      { id: "A", name: "oldest", kind: "shared", start: 2, uses: [3, 7] },
      { id: "B", name: "newest", kind: "mut", start: 5, uses: [6] },
    ],
  },
  evict: {
    id: "evict", title: "Evict while iterating", owner: "self.idle", runtime: "skip",
    rows: [
      r("let now = Instant::now();"),
      r("for (i, conn) in self.idle.iter().enumerate() {"),
      r("    if conn.idle_since + self.max_idle < now {"),
      r("        self.idle.remove(i);", "write"),
      r("    }"),
      r("} // next(): the iterator reads self.idle again"),
      r("self.metrics.idle.set(self.idle.len() as i64);", "read"),
    ],
    lanes: [{ id: "A", name: "iter", kind: "shared", start: 2, uses: [3, 6], fixed: true }],
  },
  retain: {
    id: "retain", title: "Evict with retain", owner: "self.idle", runtime: "clean",
    rows: [
      r("let now = Instant::now();"),
      r("let max_idle = self.max_idle;"),
      r("self.idle.retain(|conn| conn.idle_since + max_idle >= now);", "write"),
      r("self.metrics.idle.set(self.idle.len() as i64);", "read"),
      r('log::info!("pool swept");'),
    ],
    lanes: [],
  },
};

export const MAX_LANES = 3;

export interface Diagnostic {
  code: "E0499" | "E0502" | "E0505";
  row: number;
  message: string;
  notes: { row: number; text: string }[];
  lanes: string[];
}

export interface Finding { row: number; kind: "dangling" | "aliased" | "skip" | "ok"; text: string }

export type ChallengeId = "nll" | "e0499" | "dangle" | "skip" | "retain";
export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "nll", text: "Make Grow the pool compile while keeping both oldest and newest." },
  { id: "e0499", text: "Get the checker to report two mutable borrows at once (E0499)." },
  { id: "dangle", text: "Run a rejected Grow without the checker and find the read of freed memory." },
  { id: "skip", text: "Run Evict while iterating without the checker and find the stale connection it leaves." },
  { id: "retain", text: "Make eviction compile." },
];

export type Guess = "yes" | "cap" | "no";
export const ANSWER: Guess = "no";

export interface Tried { ok: boolean; harmful: boolean }

export interface State {
  program: ProgramId;
  lanes: Lane[];
  unchecked: boolean;
  guess: Guess | null;
  /** Distinct layouts the reader produced, keyed by program and lanes. */
  tried: Record<string, Tried>;
  edits: number;
  done: ChallengeId[];
  nextLane: number;
}

export type Action =
  | { type: "program"; program: ProgramId }
  | { type: "toggleUse"; lane: string; row: number }
  | { type: "flip"; lane: string }
  | { type: "addLane"; row: number; kind: Kind }
  | { type: "removeLane"; lane: string }
  | { type: "unchecked"; on: boolean }
  | { type: "guess"; guess: Guess }
  | { type: "reset" };

/* ---------------- the checker ---------------- */

export const lastUse = (l: Lane) => Math.max(l.start, ...l.uses);
export const live = (l: Lane, row: number) => row >= l.start && row <= lastUse(l);
const firstUseFrom = (l: Lane, row: number) => Math.min(...[l.start, ...l.uses].filter((u) => u >= row));
const firstUseAfter = (l: Lane, row: number) => Math.min(...l.uses.filter((u) => u > row));
const borrowText = (k: Kind) => (k === "mut" ? "mutable" : "immutable");

export function check(p: Program, lanes: Lane[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const o = `\`${p.owner}\``;
  // Two borrows alive at once, at least one mutable: reported where the later one starts.
  const sorted = [...lanes].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const x = sorted[i];
      const y = sorted[j];
      if (x.kind === "shared" && y.kind === "shared") continue;
      if (lastUse(x) < y.start) continue;
      const later = firstUseFrom(x, y.start);
      if (x.kind === "mut" && y.kind === "mut") {
        out.push({
          code: "E0499", row: y.start, lanes: [x.id, y.id],
          message: `cannot borrow ${o} as mutable more than once at a time`,
          notes: [{ row: x.start, text: `first mutable borrow occurs here (${x.name})` }, { row: y.start, text: `second mutable borrow occurs here (${y.name})` }, { row: later, text: "first borrow later used here" }],
        });
      } else {
        out.push({
          code: "E0502", row: y.start, lanes: [x.id, y.id],
          message: `cannot borrow ${o} as ${borrowText(y.kind)} because it is also borrowed as ${borrowText(x.kind)}`,
          notes: [{ row: x.start, text: `${borrowText(x.kind)} borrow occurs here (${x.name})` }, { row: y.start, text: `${borrowText(y.kind)} borrow occurs here (${y.name})` }, { row: later, text: `${borrowText(x.kind)} borrow later used here` }],
        });
      }
    }
  }
  // The owner itself is written, read or moved while a borrow is alive past that line.
  p.rows.forEach((row, i) => {
    const n = i + 1;
    if (row.op === "none" || row.op === "create") return;
    for (const x of lanes) {
      if (!(x.start < n && lastUse(x) > n)) continue;
      const later = firstUseAfter(x, n);
      if (row.op === "write") {
        out.push({
          code: x.kind === "mut" ? "E0499" : "E0502", row: n, lanes: [x.id],
          message: x.kind === "mut" ? `cannot borrow ${o} as mutable more than once at a time` : `cannot borrow ${o} as mutable because it is also borrowed as immutable`,
          notes: [{ row: x.start, text: `${borrowText(x.kind)} borrow occurs here (${x.name})` }, { row: n, text: "mutable borrow occurs here" }, { row: later, text: `${borrowText(x.kind)} borrow later used here` }],
        });
      } else if (row.op === "read" && x.kind === "mut") {
        out.push({
          code: "E0502", row: n, lanes: [x.id],
          message: `cannot borrow ${o} as immutable because it is also borrowed as mutable`,
          notes: [{ row: x.start, text: `mutable borrow occurs here (${x.name})` }, { row: n, text: "immutable borrow occurs here" }, { row: later, text: "mutable borrow later used here" }],
        });
      } else if (row.op === "move") {
        out.push({
          code: "E0505", row: n, lanes: [x.id],
          message: `cannot move out of ${o} because it is borrowed`,
          notes: [{ row: x.start, text: `borrow of ${o} occurs here (${x.name})` }, { row: n, text: `move out of ${o} occurs here` }, { row: later, text: "borrow later used here" }],
        });
      }
    }
  });
  return out.sort((a, b) => a.row - b.row);
}

/* ---------------- the counterfactual: run it with no checker ---------------- */

/** Python's `for c in list: list.remove(c)`, Go's index loop and forEach + splice all behave like this. */
export function evictSkipping(stale: boolean[]): { kept: number[]; staleKept: number[] } {
  const list = stale.map((s, i) => ({ id: i + 1, stale: s }));
  for (let i = 0; i < list.length; i++) {
    if (list[i].stale) {
      list.splice(i, 1); // the next element shifts into index i ...
    } // ... and the loop moves on to i + 1, stepping over it
  }
  return { kept: list.map((c) => c.id), staleKept: list.filter((c) => c.stale).map((c) => c.id) };
}

export const POOL_STALE = [false, true, true, false, true, true];

export function runUnchecked(p: Program, lanes: Lane[]): Finding[] {
  const out: Finding[] = [];
  if (p.runtime === "realloc") {
    const pushRow = p.rows.findIndex((x) => x.op === "write") + 1;
    for (const l of lanes) {
      if (l.start < pushRow && lastUse(l) > pushRow) {
        const u = firstUseAfter(l, pushRow);
        out.push({
          row: u, kind: "dangling",
          text: `push found len 4 = capacity 4, so it moved the connections to a new buffer and freed the old one. ${l.name} still points into the old buffer, so line ${u} ${l.kind === "mut" ? "writes into" : "reads"} freed memory.`,
        });
      }
    }
  }
  if (p.runtime === "skip") {
    const res = evictSkipping(POOL_STALE);
    out.push({
      row: 4, kind: "skip",
      text: `Pool of 6 with conns ${POOL_STALE.map((s, i) => (s ? i + 1 : null)).filter(Boolean).join(", ")} stale. Each remove shifted the next conn into the slot just checked, so the loop stepped over it. Kept: ${res.kept.join(", ")}. Still stale: ${res.staleKept.join(" and ")}. C++ would make the same loop undefined behaviour.`,
    });
  }
  // Two live references, one of them writing, into the same storage.
  const sorted = [...lanes].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const x = sorted[i];
      const y = sorted[j];
      if ((x.kind === "mut" || y.kind === "mut") && lastUse(x) >= y.start) {
        out.push({ row: y.start, kind: "aliased", text: `${x.name} and ${y.name} are both live at line ${y.start} and one of them writes. Nothing crashes on this line, but each side can change what the other reads, and the optimiser's no-alias assumption no longer holds.` });
      }
    }
  }
  if (p.runtime === "clean" && out.length === 0) out.push({ row: 3, kind: "ok", text: "retain walks and compacts the Vec inside one exclusive borrow. All stale connections are removed and no reference can see the half-shifted buffer." });
  if (out.length === 0) out.push({ row: 0, kind: "ok", text: "Nothing goes wrong at runtime: no reference outlives a change to the buffer." });
  return out;
}

export const harmful = (f: Finding[]) => f.some((x) => x.kind !== "ok");

/* ---------------- state ---------------- */

function laneCopy(lanes: Lane[]): Lane[] {
  return lanes.map((l) => ({ ...l, uses: [...l.uses] }));
}

const key = (p: ProgramId, lanes: Lane[]) =>
  p + "|" + [...lanes].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)).map((l) => `${l.kind}@${l.start}:${[...l.uses].sort((a, b) => a - b).join(",")}`).join(";");

function record(s: State) {
  const p = PROGRAM[s.program];
  const diags = check(p, s.lanes);
  const ok = diags.length === 0;
  s.tried = { ...s.tried, [key(s.program, s.lanes)]: { ok, harmful: !ok && harmful(runUnchecked(p, s.lanes)) } };
  const achieve = (c: ChallengeId) => { if (!s.done.includes(c)) s.done = [...s.done, c]; };
  if (s.program === "grow" && ok && s.lanes.some((l) => l.id === "A") && s.lanes.some((l) => l.id === "B")) achieve("nll");
  if (diags.some((d) => d.code === "E0499")) achieve("e0499");
  if (s.program === "retain" && ok) achieve("retain");
  if (s.unchecked) {
    const f = runUnchecked(p, s.lanes);
    if (s.program === "grow" && !ok && f.some((x) => x.kind === "dangling")) achieve("dangle");
    if (s.program === "evict" && f.some((x) => x.kind === "skip")) achieve("skip");
  }
}

export function init(): State {
  const s: State = { program: "grow", lanes: laneCopy(PROGRAM.grow.lanes), unchecked: false, guess: null, tried: {}, edits: 0, done: [], nextLane: 1 };
  record(s);
  return s;
}

/* ---------------- step ---------------- */

export function canToggle(s: State, laneId: string, row: number): boolean {
  const l = s.lanes.find((x) => x.id === laneId);
  const p = PROGRAM[s.program];
  return !!l && !l.fixed && row > l.start && row <= p.rows.length && p.rows[row - 1].usable;
}

export function canAdd(s: State, row: number): boolean {
  const p = PROGRAM[s.program];
  return s.lanes.length < MAX_LANES && row >= 1 && row <= p.rows.length && p.rows[row - 1].usable && !s.lanes.some((l) => l.start === row);
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return st.edits > 0 || st.unchecked ? st : { ...st, guess: a.guess };
    case "program": {
      if (!PROGRAMS.includes(a.program)) return st;
      const s: State = { ...st, program: a.program, lanes: laneCopy(PROGRAM[a.program].lanes), nextLane: 1 };
      record(s);
      return s;
    }
    case "toggleUse": {
      if (!canToggle(st, a.lane, a.row)) return st;
      const lanes = laneCopy(st.lanes);
      const l = lanes.find((x) => x.id === a.lane)!;
      l.uses = l.uses.includes(a.row) ? l.uses.filter((u) => u !== a.row) : [...l.uses, a.row].sort((x, y) => x - y);
      const s: State = { ...st, lanes, edits: st.edits + 1 };
      record(s);
      return s;
    }
    case "flip": {
      const l0 = st.lanes.find((x) => x.id === a.lane);
      if (!l0 || l0.fixed) return st;
      const lanes = laneCopy(st.lanes);
      const l = lanes.find((x) => x.id === a.lane)!;
      l.kind = l.kind === "mut" ? "shared" : "mut";
      const s: State = { ...st, lanes, edits: st.edits + 1 };
      record(s);
      return s;
    }
    case "addLane": {
      if (!canAdd(st, a.row)) return st;
      const id = `N${st.nextLane}`;
      const lane: Lane = { id, name: `r${st.nextLane}`, kind: a.kind, start: a.row, uses: [], added: true };
      const s: State = { ...st, lanes: [...laneCopy(st.lanes), lane], nextLane: st.nextLane + 1, edits: st.edits + 1 };
      record(s);
      return s;
    }
    case "removeLane": {
      const l = st.lanes.find((x) => x.id === a.lane);
      if (!l || l.fixed) return st;
      const s: State = { ...st, lanes: laneCopy(st.lanes.filter((x) => x.id !== a.lane)), edits: st.edits + 1 };
      record(s);
      return s;
    }
    case "unchecked": {
      const s: State = { ...st, unchecked: a.on };
      record(s);
      return s;
    }
  }
}

export const revealed = (s: State) => s.edits > 0 || s.unchecked;

export function stats(s: State) {
  const all = Object.values(s.tried);
  return {
    tried: all.length,
    rejected: all.filter((t) => !t.ok).length,
    harmful: all.filter((t) => t.harmful).length,
    accepted: all.filter((t) => t.ok).length,
  };
}
