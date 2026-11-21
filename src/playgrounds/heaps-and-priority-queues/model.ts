// Heaps playground: a job scheduler's priority queue, drawn as a tree and as the array it lives in.
//
// After this, the reader can answer: "Why does a binary heap give the most urgent job in
// O(log n) per push and pop, when a sorted list pays O(n) per push?"
// Core insight: a heap keeps only one rule, each parent is at least as urgent as its children.
// That is enough to keep the most urgent job at index 0, and repairing the rule after a push or
// a pop walks one root-to-leaf path: at most log2(n) moves. A sorted list keeps every job in
// order, so each push shifts on average half the list. Break the rule (change a priority
// without sifting) and the heap hands out the wrong job without noticing.
//
// Pure and deterministic. Lower priority number = more urgent; ties go to the older job.

export interface Job { id: number; name: string; prio: number }
export interface Frame { heap: Job[]; hi: number[]; note: string }

export const MAX_JOBS = 31; // five levels: what the tree view can draw
export const NAMES = [
  "password reset email", "invoice PDF · acme", "webhook retry #3", "nightly export · globex", "thumbnail resize",
  "search reindex", "fraud check", "weekly sales report", "cache warm · eu-west", "GDPR erasure", "payout batch",
  "SMS reminder", "image moderation", "billing sync", "sitemap rebuild", "trial expiry notice",
] as const;

/** a is more urgent than b: lower priority, then lower id (older). */
export const before = (a: Job, b: Job) => a.prio < b.prio || (a.prio === b.prio && a.id < b.id);
export const parent = (i: number) => (i - 1) >> 1;
export const left = (i: number) => 2 * i + 1;
export const depth = (i: number) => Math.floor(Math.log2(i + 1));

/** Parent-child pairs where the child is more urgent than its parent. */
export function violations(h: Job[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < h.length; i++) if (before(h[i], h[parent(i)])) out.push([parent(i), i]);
  return out;
}

/** The truly most urgent job, whatever the array looks like. */
export const trueMin = (h: Job[]) => h.reduce<Job | null>((m, j) => (m === null || before(j, m) ? j : m), null);

export interface OpResult { heap: Job[]; frames: Frame[]; moves: number; compares: number; top: number }

export function siftUp(h0: Job[], i0: number, frames: Frame[] | null): OpResult {
  const h = h0.slice();
  let i = i0, moves = 0, compares = 0;
  while (i > 0) {
    const p = parent(i);
    compares++;
    frames?.push({ heap: h.slice(), hi: [i, p], note: `Compare ${h[i].name} (${h[i].prio}) with its parent ${h[p].name} (${h[p].prio}).` });
    if (!before(h[i], h[p])) {
      frames?.push({ heap: h.slice(), hi: [i], note: `The parent is at least as urgent. The rule holds; stop.` });
      break;
    }
    [h[i], h[p]] = [h[p], h[i]];
    moves++;
    frames?.push({ heap: h.slice(), hi: [p], note: `More urgent than its parent: swap. It moves up to index ${p}.` });
    i = p;
  }
  if (i === 0 && frames) frames.push({ heap: h.slice(), hi: [0], note: `It reached the root: it is now the next job to run.` });
  return { heap: h, frames: frames ?? [], moves, compares, top: i };
}

export function siftDown(h0: Job[], i0: number, frames: Frame[] | null): OpResult {
  const h = h0.slice();
  let i = i0, moves = 0, compares = 0;
  for (;;) {
    const l = left(i), r = l + 1;
    if (l >= h.length) {
      frames?.push({ heap: h.slice(), hi: [i], note: `No children left. Done.` });
      break;
    }
    let c = l;
    if (r < h.length) {
      compares++;
      if (before(h[r], h[l])) c = r;
    }
    compares++;
    frames?.push({ heap: h.slice(), hi: [i, c], note: `Pick the more urgent child, ${h[c].name} (${h[c].prio}), and compare.` });
    if (!before(h[c], h[i])) {
      frames?.push({ heap: h.slice(), hi: [i], note: `Both children are no more urgent. The rule holds; stop.` });
      break;
    }
    [h[i], h[c]] = [h[c], h[i]];
    moves++;
    frames?.push({ heap: h.slice(), hi: [c], note: `Swap: the more urgent child moves up, ${h[c].name} moves down to index ${c}.` });
    i = c;
  }
  return { heap: h, frames: frames ?? [], moves, compares, top: i };
}

export function heapPush(h: Job[], j: Job, trace: boolean): OpResult {
  const next = [...h, j];
  const frames: Frame[] | null = trace ? [{ heap: next.slice(), hi: [next.length - 1], note: `Append ${j.name} (${j.prio}) at the end of the array, index ${next.length - 1}: the next free leaf.` }] : null;
  return siftUp(next, next.length - 1, frames);
}

export function heapPop(h: Job[], trace: boolean): OpResult & { job: Job | null } {
  if (!h.length) return { heap: h, frames: [], moves: 0, compares: 0, top: 0, job: null };
  const job = h[0];
  if (h.length === 1) return { heap: [], frames: trace ? [{ heap: [], hi: [], note: `Dispatched ${job.name}. The queue is empty.` }] : [], moves: 0, compares: 0, top: 0, job };
  const next = h.slice(0, -1);
  next[0] = h[h.length - 1];
  const frames: Frame[] | null = trace ? [
    { heap: h.slice(), hi: [0], note: `Take the root, ${job.name} (${job.prio}): it is the most urgent job.` },
    { heap: next.slice(), hi: [0], note: `Move the last job, ${next[0].name}, into the root's place and shrink the array.` },
  ] : null;
  const r = siftDown(next, 0, frames);
  return { ...r, moves: r.moves + 1, job };
}

/** Insert into a list sorted most-urgent-last, so a pop takes the end and moves nothing. */
export function sortedInsert(s: Job[], j: Job): { list: Job[]; moves: number; compares: number } {
  let lo = 0, hi = s.length, compares = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    compares++;
    if (before(j, s[mid])) lo = mid + 1; else hi = mid;
  }
  const list = s.slice();
  list.splice(lo, 0, j);
  return { list, moves: s.length - lo, compares };
}

export function sortedRemove(s: Job[], id: number): { list: Job[]; moves: number } {
  const at = s.findIndex((x) => x.id === id);
  if (at < 0) return { list: s, moves: 0 };
  return { list: s.filter((x) => x.id !== id), moves: s.length - 1 - at };
}

/** mulberry32. */
export function rand(seed: number): [number, number] {
  const s = (seed + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

/* ---------------- benchmarks: counts only, no drawing ---------------- */

export interface Bench { kind: "queue" | "topk"; n: number; k: number; heapMoves: number; sortedMoves: number; heapCompares: number; sortedCompares: number; sortAllCompares: number }

/** Push n jobs with random priorities, then pop them all, into both structures. */
export function benchQueue(n: number, seed = 7): Bench {
  let rng = seed, r: number;
  let h: Job[] = [];
  const s: Job[] = [];
  let hm = 0, hc = 0, sm = 0, sc = 0;
  for (let i = 0; i < n; i++) {
    [r, rng] = rand(rng);
    const j = { id: i, name: "", prio: Math.floor(r * 1_000_000) };
    const a = heapPush(h, j, false);
    h = a.heap; hm += a.moves; hc += a.compares;
    // in-place sorted insert, so a 10,000-job run stays fast
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; sc++; if (before(j, s[mid])) lo = mid + 1; else hi = mid; }
    sm += s.length - lo;
    s.splice(lo, 0, j);
  }
  for (let i = 0; i < n; i++) {
    const a = heapPop(h, false);
    h = a.heap; hm += a.moves; hc += a.compares;
    s.pop(); // most urgent is last: nothing moves
  }
  return { kind: "queue", n, k: n, heapMoves: hm, sortedMoves: sm, heapCompares: hc, sortedCompares: sc, sortAllCompares: Math.round(n * Math.log2(n)) };
}

/** Stream n request latencies and keep the k slowest: a size-k min-heap vs a size-k sorted list. */
export function benchTopK(n: number, k: number, seed = 11): Bench {
  let rng = seed, r: number;
  const h: number[] = [];
  const s: number[] = []; // descending: the smallest of the kept values is last
  let hm = 0, hc = 0, sm = 0, sc = 0;
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1, rr = l + 1;
      if (l >= h.length) return;
      let c = l;
      if (rr < h.length) { hc++; if (h[rr] < h[l]) c = rr; }
      hc++;
      if (h[c] >= h[i]) return;
      [h[i], h[c]] = [h[c], h[i]]; hm++; i = c;
    }
  };
  for (let i = 0; i < n; i++) {
    [r, rng] = rand(rng);
    const v = Math.round(20 - 40 * Math.log(1 - r)); // ms, long-tailed
    // heap of size k: the root is the smallest of the slowest k
    if (h.length < k) {
      h.push(v); let j = h.length - 1;
      while (j > 0) { const p = (j - 1) >> 1; hc++; if (h[j] >= h[p]) break; [h[j], h[p]] = [h[p], h[j]]; hm++; j = p; }
    } else {
      hc++;
      if (v > h[0]) { h[0] = v; hm++; down(0); }
    }
    // sorted list of size k
    if (s.length === k) {
      sc++;
      if (v <= s[k - 1]) continue;
      s.pop();
    }
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; sc++; if (s[mid] > v) lo = mid + 1; else hi = mid; }
    sm += s.length - lo;
    s.splice(lo, 0, v);
  }
  return { kind: "topk", n, k, heapMoves: hm, sortedMoves: sm, heapCompares: hc, sortedCompares: sc, sortAllCompares: Math.round(n * Math.log2(n)) };
}

/* ---------------- the interactive queue ---------------- */

export const CHALLENGES = [
  { id: "climb", text: "Push a job that climbs from the fourth level or deeper all the way to the root." },
  { id: "deep", text: "Grow the heap to five levels (16 or more jobs)." },
  { id: "wrong", text: "Make the scheduler dispatch the wrong job." },
  { id: "bench", text: "Run a load test where the sorted list moves 100 times as many jobs as the heap." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface Last { kind: "push" | "pop" | "urgent" | "corrupt"; job: Job | null; moves: number; sortedMoves: number; wrong: Job | null; levels: number }

export interface State {
  heap: Job[];
  sorted: Job[];
  frames: Frame[];
  nextId: number;
  rng: number;
  heapMoves: number;
  sortedMoves: number;
  ops: number;
  dispatched: Job[];
  wrong: number;
  last: Last | null;
  selected: number | null;
  bench: Bench | null;
  prediction: string | null;
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "push"; prio?: number }
  | { type: "pop" }
  | { type: "select"; index: number | null }
  | { type: "urgent"; index: number }
  | { type: "corrupt"; index: number }
  | { type: "bench"; kind: "queue" | "topk"; n: number }
  | { type: "predict"; value: string }
  | { type: "reset" };

function blank(): State {
  return {
    heap: [], sorted: [], frames: [], nextId: 1, rng: 0x1234567, heapMoves: 0, sortedMoves: 0, ops: 0,
    dispatched: [], wrong: 0, last: null, selected: null, bench: null, prediction: null,
    done: { climb: false, deep: false, wrong: false, bench: false },
  };
}

export const START = [40, 12, 55, 30, 18, 70, 64];

export function init(): State {
  let s = blank();
  for (const p of START) s = push(s, p);
  return { ...s, frames: [], heapMoves: 0, sortedMoves: 0, ops: 0, last: null, done: blank().done };
}

function push(s: State, prio?: number): State {
  if (s.heap.length >= MAX_JOBS) return s;
  let rng = s.rng, p = prio;
  if (p === undefined) {
    let r: number;
    [r, rng] = rand(rng);
    p = 1 + Math.floor(r * 99);
  }
  p = Math.max(1, Math.min(99, Math.round(p)));
  const job: Job = { id: s.nextId, name: NAMES[(s.nextId - 1) % NAMES.length], prio: p };
  const r = heapPush(s.heap, job, true);
  const si = sortedInsert(s.sorted, job);
  const from = s.heap.length;
  const d = { ...s.done };
  if (r.top === 0 && depth(from) >= 3) d.climb = true;
  if (r.heap.length >= 16) d.deep = true;
  return {
    ...s, rng, heap: r.heap, sorted: si.list, frames: r.frames, nextId: s.nextId + 1,
    heapMoves: s.heapMoves + r.moves, sortedMoves: s.sortedMoves + si.moves, ops: s.ops + 1,
    last: { kind: "push", job, moves: r.moves, sortedMoves: si.moves, wrong: null, levels: depth(from) - depth(r.top) },
    selected: null, done: d,
  };
}

function pop(s: State): State {
  if (!s.heap.length) return s;
  const truth = trueMin(s.heap)!;
  const r = heapPop(s.heap, true);
  const job = r.job!;
  const sr = sortedRemove(s.sorted, job.id);
  const wrong = job.id !== truth.id ? truth : null;
  return {
    ...s, heap: r.heap, sorted: sr.list, frames: r.frames,
    heapMoves: s.heapMoves + r.moves, sortedMoves: s.sortedMoves + sr.moves, ops: s.ops + 1,
    dispatched: [job, ...s.dispatched].slice(0, 8), wrong: s.wrong + (wrong ? 1 : 0),
    last: { kind: "pop", job, moves: r.moves, sortedMoves: sr.moves, wrong, levels: 0 },
    selected: null, done: wrong ? { ...s.done, wrong: true } : s.done,
  };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "push":
      return push(s, a.prio);
    case "pop":
      return pop(s);
    case "select":
      return { ...s, selected: a.index };
    case "urgent":
    case "corrupt": {
      const old = s.heap[a.index];
      if (!old) return s;
      const job = { ...old, prio: 1 };
      const h = s.heap.slice();
      h[a.index] = job;
      // The sorted list always re-files the job correctly (its moves are not the point here).
      const sorted = sortedInsert(sortedRemove(s.sorted, job.id).list, job).list;
      if (a.type === "corrupt") {
        // Change the priority in place and skip the repair: the heap rule may now be broken.
        return { ...s, heap: h, sorted, frames: [{ heap: h.slice(), hi: [a.index], note: `${job.name} is now priority 1, but nothing moved it. Its parent may be less urgent than it.` }], selected: null, last: { kind: "corrupt", job, moves: 0, sortedMoves: 0, wrong: null, levels: 0 } };
      }
      const r = siftUp(h, a.index, [{ heap: h.slice(), hi: [a.index], note: `${job.name} is now priority 1. Sift it up to restore the rule (Go's heap.Fix does this).` }]);
      return { ...s, heap: r.heap, sorted, frames: r.frames, heapMoves: s.heapMoves + r.moves, selected: null, last: { kind: "urgent", job, moves: r.moves, sortedMoves: 0, wrong: null, levels: depth(a.index) - depth(r.top) } };
    }
    case "bench": {
      const b = a.kind === "queue" ? benchQueue(a.n) : benchTopK(a.n, 100);
      const d = b.sortedMoves >= 100 * b.heapMoves ? { ...s.done, bench: true } : s.done;
      return { ...s, bench: b, done: d };
    }
  }
}
