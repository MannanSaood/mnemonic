// Memento playground: a gateway config with rollback, built two ways, receiving the same edits.
//
// After this, the reader can answer: why must the object itself take the snapshot it will later
// be restored from, and what does keeping a full snapshot per change cost compared to diffs?
//
// "Deploy tool" is the lesson's before code: the caretaker copies the config's fields itself.
// The routes map is copied by reference, so later in-place edits change the "snapshot" too, and
// a field added later is not copied at all. "Memento" is the after code: the config hands out an
// opaque snapshot that it filled itself, with its own copy of the routes.
//
// Memory is modelled faithfully enough to show aliasing: every routes map lives in a heap under
// an id, and a snapshot either shares the live map's id or holds a clone.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Routes = Record<string, string>;
export type Limits = Record<string, number>;
export type Side = "tool" | "memento";

export interface Cfg { routes: number; timeout: number; limits: Limits | null }
/** A history entry. For the deploy tool, `routes` is whatever the tool copied: the live map's id. */
export interface Snap { routes: number; timeout: number; limits: Limits | null; label: string }
export interface SideState { live: Cfg; history: Snap[]; rollbacks: number; wrong: number }

/** The plain value a config should have, for checking what a rollback restored. */
export interface Value { routes: Routes; timeout: number; limits: Limits | null }

export interface Mismatch { key: string; expected: string; got: string }
export interface RollbackResult { label: string; tool: Mismatch[]; memento: Mismatch[] }

export type Challenge = "route" | "timeout" | "limit";

export interface State {
  heap: Record<number, Routes>;
  nextId: number;
  tool: SideState;
  memento: SideState;
  /** What the config really was before each change, newest last. */
  truth: Value[];
  limitsShipped: boolean;
  last: RollbackResult | null;
  done: Challenge[];
  edits: number;
  /** Production config size the reader picked, for the memory panel. */
  size: number;
}

export type Storage = "snapshot" | "diff" | "checkpoint";

export type Action =
  | { type: "setUpstream"; path: string }
  | { type: "addRoute" }
  | { type: "removeRoute"; path: string }
  | { type: "timeout"; delta: number }
  | { type: "shipLimits" }
  | { type: "setLimit"; path: string }
  | { type: "rollback" }
  | { type: "size"; size: number }
  | { type: "reset" };

export const START_ROUTES: Routes = { "/api": "api-v1", "/auth": "auth-v1", "/static": "cdn-a" };
const EXTRA = ["/billing", "/search", "/admin", "/hooks"];
export const SIZES = [50, 500, 5000, 50000];

export function init(): State {
  const heap = { 1: { ...START_ROUTES }, 2: { ...START_ROUTES } };
  const side = (id: number): SideState => ({ live: { routes: id, timeout: 30, limits: null }, history: [], rollbacks: 0, wrong: 0 });
  return { heap, nextId: 3, tool: side(1), memento: side(2), truth: [], limitsShipped: false, last: null, done: [], edits: 0, size: 5000 };
}

export const valueOf = (st: State, c: Cfg): Value => ({ routes: { ...st.heap[c.routes] }, timeout: c.timeout, limits: c.limits ? { ...c.limits } : null });

/* ---------------- edits: the same code runs on both sides ---------------- */

type Edit = { label: string; kind: Challenge; apply: (r: Routes, c: Cfg) => { routes: Routes; cfg: Cfg } };

function nextVersion(up: string): string {
  const m = up.match(/^(.*?)(\d+)$/);
  if (m) return m[1] + (Number(m[2]) + 1);
  return up.endsWith("-a") ? up.slice(0, -1) + "b" : up + "-2";
}

function editFor(st: State, a: Action): Edit | null {
  const routes = st.heap[st.memento.live.routes];
  switch (a.type) {
    case "setUpstream": {
      if (!(a.path in routes)) return null;
      const up = nextVersion(routes[a.path]);
      return { label: `${a.path} → ${up}`, kind: "route", apply: (r, c) => ({ routes: { ...r, [a.path]: nextVersion(r[a.path] ?? up) }, cfg: c }) };
    }
    case "addRoute": {
      const path = EXTRA.find((p) => !(p in routes));
      if (!path) return null;
      return { label: `add ${path}`, kind: "route", apply: (r, c) => ({ routes: { ...r, [path]: path.slice(1) + "-v1" }, cfg: c }) };
    }
    case "removeRoute":
      if (!(a.path in routes) || Object.keys(routes).length <= 1) return null;
      return { label: `remove ${a.path}`, kind: "route", apply: (r, c) => { const n = { ...r }; delete n[a.path]; return { routes: n, cfg: c }; } };
    case "timeout": {
      const t = st.memento.live.timeout + a.delta;
      if (t < 5 || t > 120) return null;
      return { label: `timeout ${t}s`, kind: "timeout", apply: (r, c) => ({ routes: r, cfg: { ...c, timeout: c.timeout + a.delta } }) };
    }
    case "setLimit": {
      if (!st.limitsShipped) return null;
      return {
        label: `limit ${a.path}`, kind: "limit",
        apply: (r, c) => {
          const cur = c.limits?.[a.path] ?? 100;
          return { routes: r, cfg: { ...c, limits: { ...(c.limits ?? {}), [a.path]: cur >= 400 ? 100 : cur * 2 } } };
        },
      };
    }
    default:
      return null;
  }
}

/** Snapshot before the change, then edit the routes map in place (same id) and the other fields. */
function applySide(st: State, d: Side, e: Edit): { side: SideState; heap: Record<number, Routes>; nextId: number } {
  const s = st[d];
  let heap = st.heap, nextId = st.nextId;
  let snap: Snap;
  if (d === "tool") {
    // Deploy tool: copies the fields it knows about. The map is copied by reference.
    snap = { routes: s.live.routes, timeout: s.live.timeout, limits: null, label: e.label };
  } else {
    // Memento: the config clones its own state, including fields added later.
    const id = nextId++;
    heap = { ...heap, [id]: { ...heap[s.live.routes] } };
    snap = { routes: id, timeout: s.live.timeout, limits: s.live.limits ? { ...s.live.limits } : null, label: e.label };
  }
  const { routes, cfg } = e.apply(heap[s.live.routes], s.live);
  heap = { ...heap, [s.live.routes]: routes }; // in-place edit: same map, same id
  return { side: { ...s, live: { ...cfg, routes: s.live.routes }, history: [...s.history, snap] }, heap, nextId };
}

function restore(st: State, d: Side): { side: SideState; heap: Record<number, Routes>; nextId: number } {
  const s = st[d];
  const snap = s.history[s.history.length - 1];
  let heap = st.heap, nextId = st.nextId;
  let live: Cfg;
  if (d === "tool") {
    // cfg.Routes = s.Routes; cfg.Timeout = s.Timeout. Limits are not in the tool's snapshot.
    live = { ...s.live, routes: snap.routes, timeout: snap.timeout };
  } else {
    // Restore clones again, so the snapshot stays intact if it is restored twice.
    const id = nextId++;
    heap = { ...heap, [id]: { ...heap[snap.routes] } };
    live = { routes: id, timeout: snap.timeout, limits: snap.limits ? { ...snap.limits } : null };
  }
  return { side: { ...s, live, history: s.history.slice(0, -1) }, heap, nextId };
}

export function mismatches(expected: Value, got: Value): Mismatch[] {
  const out: Mismatch[] = [];
  const keys = [...new Set([...Object.keys(expected.routes), ...Object.keys(got.routes)])].sort();
  for (const k of keys)
    if (expected.routes[k] !== got.routes[k]) out.push({ key: k, expected: expected.routes[k] ?? "(no route)", got: got.routes[k] ?? "(no route)" });
  if (expected.timeout !== got.timeout) out.push({ key: "timeout", expected: `${expected.timeout}s`, got: `${got.timeout}s` });
  const lk = [...new Set([...Object.keys(expected.limits ?? {}), ...Object.keys(got.limits ?? {})])].sort();
  for (const k of lk) {
    const e = expected.limits?.[k], g = got.limits?.[k];
    if (e !== g) out.push({ key: `limit ${k}`, expected: e === undefined ? "(none)" : `${e}/s`, got: g === undefined ? "(none)" : `${g}/s` });
  }
  return out;
}

/* ---------------- memory model ---------------- */

/** Rough bytes: a route entry (path, upstream, map slot), the scalar fields, one diff record. */
export const BYTES = { route: 80, scalars: 16, diff: 160 };
export const CHECKPOINT_EVERY = 10;

/** Bytes held by a history of n entries over a config of `size` routes, and steps to restore the oldest. */
export function memory(n: number, size: number, storage: Storage): { bytes: number; worstRestore: number } {
  const snapshot = size * BYTES.route + BYTES.scalars;
  if (storage === "snapshot") return { bytes: n * snapshot, worstRestore: n ? 1 : 0 };
  if (storage === "diff") return { bytes: n * BYTES.diff, worstRestore: n };
  const checkpoints = Math.ceil(n / CHECKPOINT_EVERY);
  return { bytes: checkpoints * snapshot + (n - checkpoints) * BYTES.diff, worstRestore: Math.min(n, CHECKPOINT_EVERY) };
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "size":
      return { ...st, size: a.size };
    case "shipLimits": {
      if (st.limitsShipped) return st;
      // The config team adds per-route rate limits. The deploy tool lives elsewhere and is not updated.
      const lim: Limits = { "/api": 100 };
      return { ...st, limitsShipped: true, tool: { ...st.tool, live: { ...st.tool.live, limits: { ...lim } } }, memento: { ...st.memento, live: { ...st.memento.live, limits: { ...lim } } } };
    }
    case "rollback": {
      if (!st.memento.history.length) return st;
      const expected = st.truth[st.truth.length - 1];
      const label = st.memento.history[st.memento.history.length - 1].label;
      const t = restore(st, "tool");
      let next: State = { ...st, heap: t.heap, nextId: t.nextId, tool: t.side };
      const m = restore(next, "memento");
      next = { ...next, heap: m.heap, nextId: m.nextId, memento: m.side };
      const tool = mismatches(expected, valueOf(next, next.tool.live));
      const mem = mismatches(expected, valueOf(next, next.memento.live));
      next.tool = { ...next.tool, rollbacks: next.tool.rollbacks + 1, wrong: next.tool.wrong + (tool.length ? 1 : 0) };
      next.memento = { ...next.memento, rollbacks: next.memento.rollbacks + 1, wrong: next.memento.wrong + (mem.length ? 1 : 0) };
      // A challenge counts when the tool's rollback of that kind of change went wrong, or (timeout) went right.
      const kind: Challenge = label.startsWith("timeout") ? "timeout" : label.startsWith("limit") ? "limit" : "route";
      const hit = kind === "timeout" ? !tool.some((x) => x.key === "timeout")
        : kind === "limit" ? tool.some((x) => x.key.startsWith("limit "))
        : tool.some((x) => x.key.startsWith("/"));
      return {
        ...next,
        truth: st.truth.slice(0, -1),
        last: { label, tool, memento: mem },
        done: hit && !st.done.includes(kind) ? [...st.done, kind] : st.done,
      };
    }
    default: {
      const e = editFor(st, a);
      if (!e) return st;
      const truth = [...st.truth, valueOf(st, st.memento.live)];
      const t = applySide(st, "tool", e);
      let next: State = { ...st, heap: t.heap, nextId: t.nextId, tool: t.side };
      const m = applySide(next, "memento", e);
      next = { ...next, heap: m.heap, nextId: m.nextId, memento: m.side };
      return { ...next, truth, last: null, edits: st.edits + 1 };
    }
  }
}

/** Does the deploy tool's newest snapshot share its routes map with the live config? */
export const sharesLive = (st: State, d: Side, i: number) => st[d].history[i]?.routes === st[d].live.routes;
