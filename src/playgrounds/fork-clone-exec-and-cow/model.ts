// fork, clone, exec playground: an 8 GiB service that runs a small helper per upload.
//
// After this, the reader can answer: when a big process forks to run a small command, what is
// actually copied and what does it cost? (fork copies the page tables, not the memory, and makes
// every private page copy-on-write; each later write copies; exec throws the copy away. A
// vfork-style spawn, as posix_spawn does it, shares the memory until exec and copies nothing.)
//
// The view shows a process tree. Each process with its own memory has a strip of 32 cells, each
// standing for 256 MiB of heap (8 GiB in all). Cells shared by two processes are drawn striped;
// writing to one copies it. The reader can fork, spawn (vfork + exec), start a thread (clone
// with CLONE_VM), write, keep the parent serving writes, exec and exit, and watches host RAM,
// page tables, copies and the time each creation stalled the parent. Break-it: keep writing
// until the OOM killer fires, or switch to strict overcommit and watch fork fail with ENOMEM
// while spawn still works.
//
// Costs are a model: fork copies page tables at about 10 ms per GiB of mapped memory (in line
// with Redis's published fork timings on physical hosts), a spawn takes about 0.1 ms.
// Plain state + a pure step function, so it can be tested without a browser.

export const CELLS = 32;
export const CELL_MIB = 256;
export const HOST_MIB = 16 * 1024;
export const OTHER_MIB = 1024; // kernel, sidecars and everything else on the host
export const STRICT_LIMIT_MIB = 12 * 1024; // vm.overcommit_memory=2, ratio 75, no swap
export const TOOL_MIB = 20; // setpriv, then pdftotext
export const PT_MIB_PER_CELL = (CELL_MIB * 1024 / 4) * 8 / (1024 * 1024); // 8-byte entry per 4 KiB page: 0.5 MiB per cell
export const FORK_MS_PER_GIB = 10;
export const SPAWN_MS = 0.1;
export const THREAD_MS = 0.05;

export type Kind = "root" | "fork" | "spawn" | "thread";
export type Status = "running" | "exited" | "killed";
export interface Proc { pid: number; ppid: number | null; name: string; kind: Kind; mm: number; status: Status }
/** An address space. `cells` is null after exec: the small program's own memory. */
export interface Mm { id: number; cells: number[] | null; smallMib: number }

export interface Event { id: number; ok: boolean; text: string; path: string[] }

export interface State {
  procs: Proc[];
  mms: Record<number, Mm>;
  /** frame id -> number of address spaces using it */
  refs: Record<number, number>;
  nextPid: number;
  nextMm: number;
  nextFrame: number;
  selected: number;
  strict: boolean;
  copies: number;
  /** Time the parent was stalled creating children (ms), and how many children of each kind. */
  stallMs: number;
  created: { fork: number; spawn: number; thread: number };
  failed: number;
  peakMib: number;
  oom: boolean;
  burstAt: number;
  events: Event[];
  nextEvent: number;
  prediction: "copy" | "tables" | "nothing" | null;
}

export type Action =
  | { type: "select"; pid: number }
  | { type: "fork"; pid: number }
  | { type: "spawn"; pid: number }
  | { type: "thread"; pid: number }
  | { type: "write"; pid: number; cell: number }
  | { type: "burst"; pid: number }
  | { type: "exec"; pid: number }
  | { type: "exit"; pid: number }
  | { type: "strict" }
  | { type: "predict"; value: "copy" | "tables" | "nothing" }
  | { type: "reset" };

export function init(): State {
  const cells = Array.from({ length: CELLS }, (_, i) => i + 1);
  const st: State = {
    procs: [{ pid: 100, ppid: null, name: "server", kind: "root", mm: 1, status: "running" }],
    mms: { 1: { id: 1, cells, smallMib: 0 } },
    refs: Object.fromEntries(cells.map((c) => [c, 1])),
    nextPid: 101, nextMm: 2, nextFrame: CELLS + 1,
    selected: 100, strict: false,
    copies: 0, stallMs: 0, created: { fork: 0, spawn: 0, thread: 0 }, failed: 0,
    peakMib: 0, oom: false, burstAt: 0,
    events: [], nextEvent: 1, prediction: null,
  };
  return { ...st, peakMib: usedMib(st) };
}

const alive = (p: Proc) => p.status === "running";
export const proc = (st: State, pid: number) => st.procs.find((p) => p.pid === pid);

/** Address spaces still used by a running process. */
function liveMms(st: State): Mm[] {
  const ids = new Set(st.procs.filter(alive).map((p) => p.mm));
  return [...ids].map((id) => st.mms[id]);
}

export function pageTableMib(st: State): number {
  return liveMms(st).reduce((s, m) => s + (m.cells ? m.cells.length * PT_MIB_PER_CELL : 0.1), 0);
}

/** Host RAM in use: distinct frames, small programs, page tables, and everything else. */
export function usedMib(st: State): number {
  const frames = new Set<number>();
  let small = 0;
  for (const m of liveMms(st)) {
    if (m.cells) m.cells.forEach((f) => frames.add(f));
    else small += m.smallMib;
  }
  return OTHER_MIB + frames.size * CELL_MIB + small + pageTableMib(st);
}

/** Memory the kernel has promised (commit charge): every private writable page of every address space counts in full, shared or not. */
export function committedMib(st: State): number {
  return OTHER_MIB + liveMms(st).reduce((s, m) => s + (m.cells ? m.cells.length * CELL_MIB : m.smallMib), 0);
}

/** Cells of an address space that are still shared with another one. */
export function sharedCells(st: State, mm: number): number {
  const m = st.mms[mm];
  return m.cells ? m.cells.filter((f) => (st.refs[f] ?? 0) > 1).length : 0;
}

function event(st: State, ok: boolean, text: string, path: string[]): State {
  return { ...st, events: [{ id: st.nextEvent, ok, text, path }, ...st.events].slice(0, 5), nextEvent: st.nextEvent + 1 };
}

function release(st: State, mmId: number, exceptPid: number): Record<number, number> {
  // Drop the address space's references if no other running process uses it.
  const others = st.procs.some((p) => p.pid !== exceptPid && alive(p) && p.mm === mmId);
  const m = st.mms[mmId];
  if (others || !m.cells) return st.refs;
  const refs = { ...st.refs };
  for (const f of m.cells) refs[f] = (refs[f] ?? 1) - 1;
  return refs;
}

/** After memory grows: if the host is out of RAM, the OOM killer takes the biggest process. */
function oomCheck(st: State): State {
  const used = usedMib(st);
  if (used <= HOST_MIB) return { ...st, peakMib: Math.max(st.peakMib, used) };
  const rss = (p: Proc) => { const m = st.mms[p.mm]; return m.cells ? m.cells.length : 0; };
  const victim = st.procs.filter((p) => alive(p) && p.kind !== "thread").sort((a, b) => rss(b) - rss(a) || a.pid - b.pid)[0];
  const refs = release(st, victim.mm, victim.pid);
  const procs = st.procs.map((p) => (p.mm === victim.mm && alive(p) ? { ...p, status: "killed" as Status } : p));
  const s = { ...st, refs, procs, oom: true, peakMib: Math.max(st.peakMib, HOST_MIB) };
  return event(s, false, `Out of memory: the OOM killer killed ${victim.name} (pid ${victim.pid}), the biggest process.`, ["RAM full", "OOM killer", `kill ${victim.pid}`]);
}

function canCommit(st: State, addMib: number) {
  return !st.strict || committedMib(st) + addMib <= STRICT_LIMIT_MIB;
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "strict":
      return { ...st, strict: !st.strict };
    case "predict":
      return st.prediction ? st : { ...st, prediction: a.value };
    case "select":
      return proc(st, a.pid) ? { ...st, selected: a.pid } : st;
    case "fork": {
      const p = proc(st, a.pid);
      const m = p && st.mms[p.mm];
      if (!p || !alive(p) || !m || !m.cells) return st;
      const gib = (m.cells.length * CELL_MIB) / 1024;
      if (!canCommit(st, m.cells.length * CELL_MIB)) {
        return event({ ...st, failed: st.failed + 1 }, false,
          `fork() failed with ENOMEM: the child would commit another ${gib} GiB, over the ${STRICT_LIMIT_MIB / 1024} GiB commit limit, although it would exec a moment later.`,
          [`${p.name}`, "fork()", "commit check", "ENOMEM"]);
      }
      const refs = { ...st.refs };
      for (const f of m.cells) refs[f] += 1;
      const mm: Mm = { id: st.nextMm, cells: [...m.cells], smallMib: 0 };
      const child: Proc = { pid: st.nextPid, ppid: p.pid, name: `${p.name} (child)`, kind: "fork", mm: mm.id, status: "running" };
      const ms = gib * FORK_MS_PER_GIB;
      const s: State = {
        ...st, refs, mms: { ...st.mms, [mm.id]: mm }, procs: [...st.procs, child],
        nextPid: st.nextPid + 1, nextMm: st.nextMm + 1, selected: child.pid,
        stallMs: st.stallMs + ms, created: { ...st.created, fork: st.created.fork + 1 },
      };
      return oomCheck(event(s, true,
        `fork(): pid ${child.pid} gets a copy of the page tables (${m.cells.length * PT_MIB_PER_CELL} MiB) and shares all ${gib} GiB copy-on-write. ${p.name} stalled ${ms} ms.`,
        [p.name, "fork()", "copy page tables", "mark pages read-only", `pid ${child.pid}`]));
    }
    case "spawn": {
      const p = proc(st, a.pid);
      if (!p || !alive(p)) return st;
      if (!canCommit(st, TOOL_MIB)) return event({ ...st, failed: st.failed + 1 }, false, "spawn failed: over the commit limit.", [p.name, "spawn", "ENOMEM"]);
      const mm: Mm = { id: st.nextMm, cells: null, smallMib: TOOL_MIB };
      const child: Proc = { pid: st.nextPid, ppid: p.pid, name: "pdftotext", kind: "spawn", mm: mm.id, status: "running" };
      const s: State = {
        ...st, mms: { ...st.mms, [mm.id]: mm }, procs: [...st.procs, child],
        nextPid: st.nextPid + 1, nextMm: st.nextMm + 1, selected: child.pid,
        stallMs: st.stallMs + SPAWN_MS, created: { ...st.created, spawn: st.created.spawn + 1 },
      };
      return oomCheck(event(s, true,
        `posix_spawn(): clone(CLONE_VM|CLONE_VFORK) borrows ${p.name}'s memory, execs at once, and pid ${child.pid} runs pdftotext in ${TOOL_MIB} MiB of its own. Nothing copied; ${p.name} waited ${SPAWN_MS} ms.`,
        [p.name, "clone(VM|VFORK)", "exec", `pid ${child.pid}`]));
    }
    case "thread": {
      const p = proc(st, a.pid);
      if (!p || !alive(p) || !st.mms[p.mm].cells) return st;
      const t: Proc = { pid: st.nextPid, ppid: p.pid, name: "worker thread", kind: "thread", mm: p.mm, status: "running" };
      const s: State = {
        ...st, procs: [...st.procs, t], nextPid: st.nextPid + 1, selected: t.pid,
        stallMs: st.stallMs + THREAD_MS, created: { ...st.created, thread: st.created.thread + 1 },
      };
      return event(s, true, `clone(CLONE_VM|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|...): task ${t.pid} uses the same address space. Its writes are the process's writes; nothing is ever copied.`,
        [p.name, "clone(VM|THREAD)", `task ${t.pid}`]);
    }
    case "write": {
      const p = proc(st, a.pid);
      const m = p && st.mms[p.mm];
      if (!p || !alive(p) || !m || !m.cells) return st;
      const f = m.cells[a.cell];
      if ((st.refs[f] ?? 0) <= 1) {
        return event(st, true, `Write to cell ${a.cell} by ${p.pid}: private already, no fault.`, [`${p.pid}`, `write ${a.cell}`, "no fault"]);
      }
      const nf = st.nextFrame;
      const refs = { ...st.refs, [f]: st.refs[f] - 1, [nf]: 1 };
      const cells = [...m.cells];
      cells[a.cell] = nf;
      const s = { ...st, refs, nextFrame: nf + 1, mms: { ...st.mms, [m.id]: { ...m, cells } }, copies: st.copies + 1 };
      return oomCheck(event(s, false, `Write to cell ${a.cell} by ${p.pid}: copy-on-write faults copy ${CELL_MIB} MiB, one 4 KiB page at a time.`, [`${p.pid}`, `write ${a.cell}`, "COW fault", `copy ${CELL_MIB} MiB`]));
    }
    case "burst": {
      // The parent keeps serving: four more cells of heap get written.
      let s = st;
      const p = proc(st, a.pid);
      if (!p || !alive(p) || !st.mms[p.mm].cells) return st;
      for (let i = 0; i < 4; i++) {
        const cell = (st.burstAt + i) % CELLS;
        s = step(s, { type: "write", pid: a.pid, cell });
        if (!alive(proc(s, a.pid)!)) break;
      }
      return { ...s, burstAt: (st.burstAt + 4) % CELLS };
    }
    case "exec": {
      const p = proc(st, a.pid);
      if (!p || !alive(p) || p.kind !== "fork") return st;
      const refs = release(st, p.mm, p.pid);
      const mm: Mm = { id: st.nextMm, cells: null, smallMib: TOOL_MIB };
      const procs = st.procs.map((x) => (x.pid === p.pid ? { ...x, name: "pdftotext", mm: mm.id } : x));
      const s: State = { ...st, refs, procs, mms: { ...st.mms, [mm.id]: mm }, nextMm: st.nextMm + 1 };
      return event(s, true, `execve(): pid ${p.pid} drops its copy of the address space and loads pdftotext into a new one. Same pid; the shared pages go back to the parent alone.`,
        [`${p.pid}`, "execve()", "drop old mm", "map the ELF"]);
    }
    case "exit": {
      const p = proc(st, a.pid);
      if (!p || !alive(p) || p.kind === "root") return st;
      const refs = release(st, p.mm, p.pid);
      const procs = st.procs.map((x) => (x.pid === p.pid ? { ...x, status: "exited" as Status } : x));
      return event({ ...st, refs, procs, selected: p.ppid ?? st.selected }, true, `pid ${p.pid} exits and is reaped.`, [`${p.pid}`, "exit", "wait"]);
    }
  }
}

/** The guided scenario: fork, let the parent keep serving, then exec in the child. */
export const FORK_SCENARIO: Action[] = [
  { type: "fork", pid: 100 },
  { type: "burst", pid: 100 },
  { type: "exec", pid: 101 },
];
