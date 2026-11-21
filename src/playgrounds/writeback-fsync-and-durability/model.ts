// Writeback and fsync playground: a crash lab. A service saves a 2 MB snapshot (data.json, version
// v2 replacing v1) and then replies "saved" to its client. The reader chooses how the save is
// written, then pulls the power plug after any step, or at every step at once, and sees what is
// in data.json after the reboot.
//
// After this, the reader can answer: when write() returns, where is my data, and which calls, in
// which order, make a replaced file survive a power cut? (write() only dirties pages in the page
// cache. The kernel writes metadata at the next journal commit, about every 5 s, and data when it
// has been dirty for 30 s, so a crash can leave an empty file. fsync makes the file durable, a
// rename makes the switch atomic, and only an fsync of the directory makes the rename durable
// before you reply.)
//
// The durable state follows the rules fsync(2) states and a journaling file system with delayed
// allocation (ext4 data=ordered without its auto_da_alloc heuristic, or XFS): metadata such as a
// truncate or a rename reaches the journal at the next commit, while the data blocks are only
// written when writeback or fsync writes them. Plain state + pure functions, tested.

export type Mode = "inplace" | "rename";
export interface Recipe { mode: Mode; fsyncFile: boolean; fsyncDir: boolean }

export type EventId =
  | "open" | "write" | "commitEarly" | "fsync" | "rename" | "fsyncDir" | "reply" | "commit" | "writeback";

export interface Step {
  id: EventId;
  /** who acts: the program, or the kernel in the background */
  by: "app" | "kernel";
  /** what the reader sees in the timeline */
  label: string;
  /** milliseconds this step adds before the reply (app steps only) */
  ms: number;
}

/** Durable state on the disk, after the steps so far. */
export interface Disk {
  /** in-place: the inode's committed size/metadata, and whether its new data blocks are on disk */
  meta: "old" | "truncated" | "new";
  data: "old" | "new";
  /** rename: whether the directory on disk points data.json at the new inode, and whether that inode's data is on disk */
  dirNew: boolean;
  tmpData: boolean;
}

export type Content = "v1" | "v2" | "empty";
export type Verdict = "new" | "old-retry" | "lost-ack" | "empty";

export interface Crash { after: number; content: Content; acked: boolean; verdict: Verdict }

export interface Sweep { recipe: Recipe; crashes: Crash[]; replyMs: number; lostAck: number; empty: number }

export interface State {
  recipe: Recipe;
  /** the step the plug was pulled after (-1: before the first step), or null if not pulled */
  plug: number | null;
  crash: Crash | null;
  /** every crash the reader has caused, with the recipe at the time */
  crashes: { recipe: Recipe; crash: Crash }[];
  sweeps: Sweep[];
}

export type Action =
  | { type: "mode"; mode: Mode }
  | { type: "fsyncFile"; on: boolean }
  | { type: "fsyncDir"; on: boolean }
  | { type: "plug"; after: number }
  | { type: "sweep" }
  | { type: "reset" };

export const FSYNC_FILE_MS = 6;   // fsync of 2 MB on a typical SSD: data plus a journal commit and cache flush
export const FSYNC_DIR_MS = 2;    // fsync of a directory: one journal commit
export const WRITE_MS = 0.4;      // copying 2 MB into the page cache

export function init(): State {
  return { recipe: { mode: "rename", fsyncFile: true, fsyncDir: false }, plug: null, crash: null, crashes: [], sweeps: [] };
}

/* ---------------- the timeline for a recipe ---------------- */

export function steps(r: Recipe): Step[] {
  const out: Step[] = [];
  const target = r.mode === "inplace" ? "data.json" : "data.json.tmp";
  out.push({ id: "open", by: "app", label: r.mode === "inplace" ? "open data.json, truncating it" : "create data.json.tmp", ms: 0.02 });
  out.push({ id: "write", by: "app", label: `write 2 MB (v2) to ${target}: the pages are dirty in the page cache`, ms: WRITE_MS });
  out.push({ id: "commitEarly", by: "kernel", label: "the periodic journal commit (every 5 s) lands while the snapshot is being written", ms: 0 });
  if (r.fsyncFile) out.push({ id: "fsync", by: "app", label: `fsync ${target}: data and inode on disk`, ms: FSYNC_FILE_MS });
  if (r.mode === "rename") {
    out.push({ id: "rename", by: "app", label: "rename data.json.tmp over data.json", ms: 0.02 });
    if (r.fsyncDir) out.push({ id: "fsyncDir", by: "app", label: "fsync the directory: the rename is on disk", ms: FSYNC_DIR_MS });
  }
  out.push({ id: "reply", by: "app", label: "close, and reply \"saved\" to the client", ms: 0.01 });
  out.push({ id: "commit", by: "kernel", label: "+5 s: the next journal commit writes pending metadata", ms: 0 });
  out.push({ id: "writeback", by: "kernel", label: "+30 s: the flusher writes pages that have been dirty for 30 s", ms: 0 });
  return out;
}

const OLD: Disk = { meta: "old", data: "old", dirNew: false, tmpData: false };

/** Apply one step to the durable state. */
function apply(d: Disk, r: Recipe, id: EventId, before: EventId[]): Disk {
  const wrote = before.includes("write");
  switch (id) {
    case "commitEarly":
    case "commit":
      if (r.mode === "inplace") {
        // The truncate (and size) reach the journal. Delayed allocation: data blocks not written yet.
        if (!before.includes("open")) return d;
        return { ...d, meta: d.data === "new" ? "new" : "truncated" };
      }
      // Rename: pending directory changes reach the journal.
      return { ...d, dirNew: d.dirNew || before.includes("rename") };
    case "fsync":
      return r.mode === "inplace" ? { ...d, meta: "new", data: "new" } : { ...d, tmpData: true };
    case "fsyncDir":
      return { ...d, dirNew: true };
    case "writeback":
      // Data dirty for 30 s is written, and with it the metadata that describes it.
      if (!wrote) return d;
      return r.mode === "inplace" ? { ...d, meta: "new", data: "new" } : { ...d, tmpData: true, dirNew: d.dirNew || before.includes("rename") };
    default:
      return d;
  }
}

export function diskAfter(r: Recipe, after: number): Disk {
  const s = steps(r);
  let d = OLD;
  for (let i = 0; i <= after && i < s.length; i++) d = apply(d, r, s[i].id, s.slice(0, i).map((x) => x.id));
  return d;
}

export function contentOf(r: Recipe, d: Disk): Content {
  if (r.mode === "inplace") return d.meta === "old" ? "v1" : d.meta === "truncated" ? "empty" : "v2";
  return d.dirNew ? (d.tmpData ? "v2" : "empty") : "v1";
}

export function crashAt(r: Recipe, after: number): Crash {
  const s = steps(r);
  const reply = s.findIndex((x) => x.id === "reply");
  const content = contentOf(r, diskAfter(r, after));
  const acked = after >= reply;
  const verdict: Verdict = content === "empty" ? "empty" : content === "v2" ? "new" : acked ? "lost-ack" : "old-retry";
  return { after, content, acked, verdict };
}

export const replyMs = (r: Recipe) => {
  const s = steps(r);
  let ms = 0;
  for (const x of s) { ms += x.ms; if (x.id === "reply") break; }
  return ms;
};

export function sweep(r: Recipe): Sweep {
  const n = steps(r).length;
  const crashes = Array.from({ length: n + 1 }, (_, k) => crashAt(r, k - 1));
  return {
    recipe: { ...r }, crashes, replyMs: replyMs(r),
    lostAck: crashes.filter((c) => c.verdict === "lost-ack").length,
    empty: crashes.filter((c) => c.verdict === "empty").length,
  };
}

export const SAFE: Recipe = { mode: "rename", fsyncFile: true, fsyncDir: true };
export const isSafe = (s: Sweep) => s.lostAck === 0 && s.empty === 0;
export const sameRecipe = (a: Recipe, b: Recipe) => a.mode === b.mode && a.fsyncFile === b.fsyncFile && (a.mode === "inplace" || a.fsyncDir === b.fsyncDir);

/* ---------------- step ---------------- */

function withRecipe(st: State, recipe: Recipe): State {
  return { ...st, recipe, plug: null, crash: null };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "mode":
      return withRecipe(st, { ...st.recipe, mode: a.mode });
    case "fsyncFile":
      return withRecipe(st, { ...st.recipe, fsyncFile: a.on });
    case "fsyncDir":
      return withRecipe(st, { ...st.recipe, fsyncDir: a.on });
    case "plug": {
      const n = steps(st.recipe).length;
      if (a.after < -1 || a.after >= n) return st;
      const crash = crashAt(st.recipe, a.after);
      return { ...st, plug: a.after, crash, crashes: [...st.crashes, { recipe: { ...st.recipe }, crash }] };
    }
    case "sweep":
      return { ...st, sweeps: [...st.sweeps.filter((s) => !sameRecipe(s.recipe, st.recipe)), sweep(st.recipe)] };
  }
}

/* ---------------- what the reader has found ---------------- */

export interface Goals { empty: boolean; lostWithFsync: boolean; safe: boolean; predictSeen: boolean }
export function goals(st: State): Goals {
  const all = [...st.crashes, ...st.sweeps.flatMap((s) => s.crashes.map((crash) => ({ recipe: s.recipe, crash })))];
  return {
    empty: all.some((c) => c.crash.verdict === "empty"),
    lostWithFsync: all.some((c) => c.recipe.fsyncFile && c.crash.verdict === "lost-ack"),
    safe: st.sweeps.some(isSafe),
    predictSeen: st.crashes.some((c) => c.recipe.mode === "rename" && c.recipe.fsyncFile && !c.recipe.fsyncDir && c.crash.acked)
      || st.sweeps.some((s) => sameRecipe(s.recipe, { mode: "rename", fsyncFile: true, fsyncDir: false })),
  };
}
