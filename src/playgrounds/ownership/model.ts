// Ownership playground: one frame buffer, three memory models.
//
// Purpose. After this, the reader can answer: "Who frees this buffer, and can anyone still be
// using it when they do?" In Rust every allocation has exactly one owner: a move hands it on and
// makes the old name unusable (E0382), and the owner's scope end frees it exactly once. With a
// garbage collector two names may share a buffer, so a pool that recycles it lets one tenant's
// frame show up in another's audit entry. With manual free, each holder frees what it holds, so
// the same steps free a buffer twice or read it after it was freed.
//
// The reader drives `ingest` for one frame from tenant acme: send the buffer to the audit task,
// put it back in the pool, clone it, read it, end the ingest scope, let the next request (tenant
// globex) take a buffer, and let the audit task write its entry. The same steps run under three
// modes, and the numbers per mode are kept for the final comparison.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Mode = "rust" | "gc" | "manual";
export const MODES: Mode[] = ["rust", "gc", "manual"];
export type VarName = "buf" | "copy";
export type Slot = VarName | "audit" | "pool" | "next";
export const FRAME_BYTES = 4096;

export interface Block {
  id: number;
  /** Whose frame the bytes currently hold. */
  tenant: "acme" | "globex";
  freed: boolean;
}

export interface SlotState {
  /** The block this name points at (null if empty). */
  block: number | null;
  /** Rust only: the value was moved out; the name can no longer be used. */
  movedTo: Slot | null;
}

export interface Tally {
  steps: number;
  compileErrors: number;
  /** Audit entries that recorded another tenant's frame. */
  wrongEntries: number;
  /** Correct audit entries. */
  goodEntries: number;
  useAfterFree: number;
  doubleFrees: number;
  frees: number;
  bytesCopied: number;
}
const tally = (): Tally => ({ steps: 0, compileErrors: 0, wrongEntries: 0, goodEntries: 0, useAfterFree: 0, doubleFrees: 0, frees: 0, bytesCopied: 0 });

export interface Ev { id: number; ok: boolean; path: string[]; text: string }

export type ChallengeId = "wrongEntry" | "doubleFree" | "refused" | "rustBoth";
export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "wrongEntry", text: "Make the audit log record globex's frame for acme." },
  { id: "doubleFree", text: "Free the same allocation twice." },
  { id: "refused", text: "Watch Rust refuse a step that the other modes run." },
  { id: "rustBoth", text: "In Rust, get a correct audit entry and a buffer back into the pool." },
];

export type Guess = "shared" | "copy" | "error";
export const ANSWER: Guess = "error";

export interface State {
  mode: Mode;
  blocks: Block[];
  slots: Record<Slot, SlotState>;
  ingestOpen: boolean;
  auditDone: boolean;
  /** The pool received a buffer in this run. */
  pooled: boolean;
  nextId: number;
  seq: number;
  log: Ev[];
  run: Tally;
  totals: Record<Mode, Tally>;
  touched: { blocks: number[]; slots: Slot[] };
  /** The last refused step, for the compiler-error banner. */
  error: string | null;
  /** The program crashed (manual double free). */
  crashed: boolean;
  guess: Guess | null;
  done: ChallengeId[];
}

export type Action =
  | { type: "mode"; mode: Mode }
  | { type: "send"; from: VarName }
  | { type: "put"; from: VarName }
  | { type: "clone" }
  | { type: "read"; v: VarName }
  | { type: "endIngest" }
  | { type: "nextRequest" }
  | { type: "auditWrite" }
  | { type: "guess"; guess: Guess }
  | { type: "reset" };

const LOG_MAX = 6;
const SLOTS: Slot[] = ["buf", "copy", "audit", "pool", "next"];
const empty = (): SlotState => ({ block: null, movedTo: null });

function program(mode: Mode, seq: number): Pick<State, "mode" | "blocks" | "slots" | "ingestOpen" | "auditDone" | "pooled" | "nextId" | "run" | "touched" | "error" | "crashed"> & { log: Ev[]; seq: number } {
  const slots = {} as Record<Slot, SlotState>;
  for (const s of SLOTS) slots[s] = empty();
  slots.buf.block = 1;
  return {
    mode,
    blocks: [{ id: 1, tenant: "acme", freed: false }],
    slots,
    ingestOpen: true,
    auditDone: false,
    pooled: false,
    nextId: 2,
    run: tally(),
    touched: { blocks: [1], slots: ["buf"] },
    error: null,
    crashed: false,
    seq: seq + 1,
    log: [{ id: seq + 1, ok: true, path: ["pool.take()", "read_frame", "H1 ← acme"], text: "ingest took a 4 KiB buffer (H1) and read a frame from tenant acme into it. buf points at H1." }],
  };
}

export function init(): State {
  const totals = { rust: tally(), gc: tally(), manual: tally() };
  return { ...program("rust", 0), totals, guess: null, done: [] };
}

/* ---------------- helpers ---------------- */

function clone(s: State): State {
  const slots = {} as Record<Slot, SlotState>;
  for (const k of SLOTS) slots[k] = { ...s.slots[k] };
  return {
    ...s, slots, blocks: s.blocks.map((b) => ({ ...b })), run: { ...s.run },
    totals: { rust: { ...s.totals.rust }, gc: { ...s.totals.gc }, manual: { ...s.totals.manual } },
    touched: { blocks: [], slots: [] }, done: [...s.done], error: null,
  };
}

function push(s: State, e: Omit<Ev, "id">) {
  s.seq++;
  s.log = [{ ...e, id: s.seq }, ...s.log].slice(0, LOG_MAX);
}

function count(s: State, k: keyof Tally, n = 1) {
  s.run[k] += n;
  s.totals[s.mode][k] += n;
}

function achieve(s: State, c: ChallengeId) {
  if (!s.done.includes(c)) s.done.push(c);
}

const block = (s: State, id: number) => s.blocks.find((b) => b.id === id)!;
const h = (id: number) => `H${id}`;
const label: Record<Slot, string> = { buf: "buf", copy: "copy", audit: "the audit task", pool: "the pool", next: "the next request" };

/** Which names point at a block now (live ingest variables, audit entry, pool, next request). */
export function holders(s: State, id: number): Slot[] {
  return SLOTS.filter((k) => {
    if ((k === "buf" || k === "copy") && !s.ingestOpen) return false;
    if (k === "audit" && s.auditDone) return false;
    if (s.slots[k].movedTo) return false;
    return s.slots[k].block === id;
  });
}

/** A block nobody points at: in GC mode it is garbage, collected later. */
export function unreachable(s: State, id: number): boolean {
  return holders(s, id).length === 0;
}

/** Rust refuses any use of a name whose value was moved out (E0382). */
function refuseMoved(s: State, v: VarName, what: string, borrow: boolean): boolean {
  const sl = s.slots[v];
  if (s.mode !== "rust" || !sl.movedTo) return false;
  count(s, "compileErrors");
  achieve(s, "refused");
  s.error = `error[E0382]: ${borrow ? "borrow" : "use"} of moved value: \`${v}\`. It moved to ${label[sl.movedTo]} earlier, so ${what} never compiles.`;
  push(s, { ok: false, path: [what, `${v}: moved`, "E0382"], text: `Refused at compile time. ${v} was moved to ${label[sl.movedTo]}, so this name no longer owns anything.` });
  return true;
}

/** Free a block on behalf of a holder (manual and Rust drops). */
function free(s: State, id: number, by: string) {
  const b = block(s, id);
  s.touched.blocks.push(id);
  if (b.freed) {
    count(s, "doubleFrees");
    s.crashed = true;
    achieve(s, "doubleFree");
    push(s, { ok: false, path: [by, `free(${h(id)})`, "already freed", "abort"], text: `${by} freed ${h(id)}, which was already freed. glibc aborts with "free(): double free detected"; worse allocators corrupt their lists silently.` });
    return;
  }
  b.freed = true;
  count(s, "frees");
}

/* ---------------- the steps ---------------- */

function transfer(s: State, from: VarName, to: "audit" | "pool") {
  const what = to === "audit" ? `audit.send(${from})` : `pool.put(${from})`;
  if (refuseMoved(s, from, what, false)) return;
  const id = s.slots[from].block!;
  s.slots[to].block = id;
  s.touched.slots.push(from, to);
  s.touched.blocks.push(id);
  if (to === "pool") s.pooled = true;
  if (s.mode === "rust") {
    s.slots[from].movedTo = to;
    push(s, { ok: true, path: [what, `move ${h(id)}`, `${from} → moved`], text: `${what} moved ${h(id)} to ${label[to]}. Only the pointer, length and capacity were copied. ${from} is now unusable, so it cannot touch these bytes again.` });
    return;
  }
  const n = holders(s, id).length;
  push(s, { ok: n < 2, path: [what, `copy pointer to ${h(id)}`, `${n} holders`], text: `${what} copied the pointer. ${from} still points at ${h(id)} too, so ${n} names now share one buffer and nothing says who owns it.` });
}

function doClone(s: State) {
  if (refuseMoved(s, "buf", "buf.clone()", true)) return;
  const src = block(s, s.slots.buf.block!);
  const id = s.nextId++;
  s.blocks.push({ id, tenant: src.tenant, freed: src.freed });
  s.slots.copy = { block: id, movedTo: null };
  count(s, "bytesCopied", FRAME_BYTES);
  s.touched.blocks.push(id);
  s.touched.slots.push("copy");
  push(s, { ok: true, path: ["buf.clone()", "alloc 4 KiB", `copy → ${h(id)}`], text: `clone() allocated ${h(id)} and copied all 4 KiB of ${src.tenant}'s frame into it. copy owns the new buffer; buf still owns ${h(src.id)}.` });
}

function read(s: State, v: VarName) {
  if (refuseMoved(s, v, `parse(&${v})`, true)) return;
  const id = s.slots[v].block!;
  const b = block(s, id);
  s.touched.slots.push(v);
  s.touched.blocks.push(id);
  if (b.freed) {
    count(s, "useAfterFree");
    push(s, { ok: false, path: [`parse(&${v})`, h(id), "freed"], text: `${v} still points at ${h(id)}, which was freed. The read sees whatever the allocator left there: use after free.` });
    return;
  }
  push(s, { ok: b.tenant === "acme", path: [`parse(&${v})`, h(id), b.tenant], text: b.tenant === "acme" ? `${v} reads acme's frame from ${h(id)}.` : `${v} reads ${h(id)} and finds globex's frame. The buffer was handed to the next request while ${v} still pointed at it.` });
}

function endIngest(s: State) {
  s.ingestOpen = false;
  s.touched.slots.push("buf", "copy");
  const order: VarName[] = ["copy", "buf"]; // reverse order of declaration
  const parts: string[] = [];
  for (const v of order) {
    const sl = s.slots[v];
    if (sl.block === null) continue;
    if (s.mode === "rust") {
      if (sl.movedTo) { parts.push(`${v} was moved, so it is skipped`); continue; }
      free(s, sl.block, `drop(${v})`);
      parts.push(`drop(${v}) freed ${h(sl.block)}`);
    } else if (s.mode === "manual") {
      const was = block(s, sl.block).freed;
      free(s, sl.block, `free(${v})`);
      parts.push(was ? `free(${v}) hit ${h(sl.block)} a second time` : `free(${v}) freed ${h(sl.block)}`);
      if (!was && holders(s, sl.block).length) parts.push(`${holders(s, sl.block).map((k) => label[k]).join(" and ")} still point at it`);
    } else {
      parts.push(`${v} goes away; ${h(sl.block)} ${unreachable(s, sl.block) ? "is now garbage, freed at some later collection" : "stays alive, because something else points at it"}`);
    }
  }
  push(s, {
    ok: !s.crashed, path: ["} end of ingest", ...(s.mode === "rust" ? ["drop owned, skip moved"] : s.mode === "manual" ? ["free each pointer"] : ["names vanish"])],
    text: parts.length ? `The ingest scope ended. ${parts.join("; ")}.` : "The ingest scope ended. It owned nothing any more, so nothing was freed here.",
  });
}

function nextRequest(s: State) {
  if (s.slots.next.block !== null) return;
  let id: number;
  let how: string;
  const pooled = s.slots.pool.block;
  if (pooled !== null) {
    id = pooled;
    s.slots.pool.block = null;
    how = `took ${h(id)} from the pool`;
  } else {
    // malloc hands back a freed chunk if there is one; a GC only reuses what nobody points at
    const reusable = s.blocks.find((b) => b.freed && (s.mode !== "gc"));
    if (reusable) {
      id = reusable.id;
      how = `got ${h(id)} back from the allocator, which reused the chunk just freed`;
    } else {
      id = s.nextId++;
      s.blocks.push({ id, tenant: "globex", freed: false });
      how = `allocated a fresh buffer ${h(id)}`;
    }
  }
  const b = block(s, id);
  b.tenant = "globex";
  b.freed = false;
  s.slots.next.block = id;
  s.touched.slots.push("next");
  s.touched.blocks.push(id);
  const others = holders(s, id).filter((k) => k !== "next");
  push(s, {
    ok: others.length === 0, path: ["next request", how.split(",")[0], `${h(id)} ← globex`],
    text: `The next request ${how} and wrote globex's frame into it.${others.length ? ` ${others.map((k) => label[k]).join(" and ")} still point at ${h(id)}, and now see globex's bytes.` : " Nobody else can see these bytes."}`,
  });
}

function auditWrite(s: State) {
  const id = s.slots.audit.block;
  if (id === null || s.auditDone) return;
  const b = block(s, id);
  s.touched.slots.push("audit");
  s.touched.blocks.push(id);
  let text: string;
  let ok = false;
  if (b.freed) {
    count(s, "useAfterFree");
    count(s, "wrongEntries");
    text = `The audit task wrote ${h(id)}, which had been freed. The entry is whatever the allocator left there.`;
  } else if (b.tenant !== "acme") {
    count(s, "wrongEntries");
    achieve(s, "wrongEntry");
    text = `The audit task wrote ${h(id)} as acme's entry, but it now holds globex's frame. One tenant's data is in another tenant's audit record.`;
  } else {
    count(s, "goodEntries");
    ok = true;
    text = `The audit task wrote acme's frame from ${h(id)}. Correct entry.`;
  }
  s.auditDone = true;
  // the audit task's scope ends: what does each model do with its buffer?
  if (s.mode === "rust") {
    free(s, id, "drop(entry)");
    text += ` Its scope ended, so drop freed ${h(id)}: the one owner, once.`;
  } else if (s.mode === "manual") {
    const was = b.freed;
    free(s, id, "free(entry)");
    if (!was) text += ` Then it freed ${h(id)}.`;
  } else {
    text += unreachable(s, id) ? ` ${h(id)} is now unreachable and will be collected later.` : ` ${h(id)} stays alive: ${holders(s, id).map((k) => label[k]).join(" and ")} still point at it.`;
  }
  if (s.mode === "rust" && ok && s.pooled) achieve(s, "rustBoth");
  push(s, { ok: ok && !s.crashed, path: ["audit.append", h(id), b.freed && s.mode !== "manual" ? "freed" : b.tenant], text });
}

/* ---------------- what is allowed (for the view) ---------------- */

export function canUse(s: State, v: VarName): boolean {
  // Moved names stay clickable in Rust: the refusal is the lesson.
  return s.ingestOpen && s.slots[v].block !== null && !s.crashed;
}
export const canSend = (s: State, v: VarName) => canUse(s, v) && s.slots.audit.block === null;
export const canPut = (s: State, v: VarName) => canUse(s, v) && s.slots.pool.block === null && s.slots.next.block === null;
export const canClone = (s: State) => canUse(s, "buf") && s.slots.copy.block === null;
export const canAudit = (s: State) => s.slots.audit.block !== null && !s.auditDone && !s.crashed;
export const canNext = (s: State) => s.slots.next.block === null && !s.crashed;

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return revealed(st) ? st : { ...st, guess: a.guess };
    case "mode": {
      if (!MODES.includes(a.mode)) return st;
      const s = clone(st);
      Object.assign(s, program(a.mode, s.seq));
      return s;
    }
    case "send":
    case "put": {
      if (!(a.type === "send" ? canSend(st, a.from) : canPut(st, a.from))) return st;
      const s = clone(st);
      count(s, "steps");
      transfer(s, a.from, a.type === "send" ? "audit" : "pool");
      return s;
    }
    case "clone": {
      if (!canClone(st)) return st;
      const s = clone(st);
      count(s, "steps");
      doClone(s);
      return s;
    }
    case "read": {
      if (!canUse(st, a.v)) return st;
      const s = clone(st);
      count(s, "steps");
      read(s, a.v);
      return s;
    }
    case "endIngest": {
      if (!st.ingestOpen || st.crashed) return st;
      const s = clone(st);
      count(s, "steps");
      endIngest(s);
      return s;
    }
    case "nextRequest": {
      if (!canNext(st)) return st;
      const s = clone(st);
      count(s, "steps");
      nextRequest(s);
      return s;
    }
    case "auditWrite": {
      if (!canAudit(st)) return st;
      const s = clone(st);
      count(s, "steps");
      auditWrite(s);
      return s;
    }
  }
}

/** The predict question is answered once the reader has taken two steps in any mode. */
export function revealed(s: State): boolean {
  return s.totals.rust.steps + s.totals.gc.steps + s.totals.manual.steps >= 2;
}
