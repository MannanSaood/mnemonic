// Factory Method playground: ship a new export format on top of a job you do not own.
//
// After this, the reader can answer: why does a creation hook (createWriter) let another team
// add a product without editing, forking or waiting for the code that runs it, and still
// inherit every later fix to that code?
//
// Setup. The platform team owns ExportJob.run(): open a temp file, make a writer, write rows,
// close, upload. The Billing team (the reader) must deliver a nightly XLSX export from day 1.
// The reader picks how: ask platform to add a case (PR), copy run() into their repo (fork), or
// subclass and override only createWriter() (possible only when the platform job has that hook).
// Then 14 nights run. On a set night the platform ships a fix to run() (verify the upload's
// checksum and retry). On another night an upload is silently truncated. Who catches it depends
// on whether their run() is the platform's or a stale copy.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Design = "switch" | "hook";
export type Approach = "pr" | "fork" | "override";
export const APPROACHES: Approach[] = ["pr", "fork", "override"];

export const NIGHTS = 14;
/** The platform ships "verify checksum, retry upload" in run() on this night. */
export const FIX_NIGHT = 8;
/** The S3 upload is truncated on this night. */
export const CORRUPT_NIGHT = 10;

/** Lines Billing writes and then owns, per approach (as in the lesson's code). */
export const LINES_OWNED: Record<Approach, number> = { pr: 0, fork: 31, override: 4 };
/** Lines copied from platform code, which go stale when platform changes them. */
export const LINES_COPIED: Record<Approach, number> = { pr: 0, fork: 27, override: 0 };

export type NightResult = "missing" | "ok" | "retried" | "corrupt";
export interface Night {
  n: number;
  result: NightResult;
  /** Hops of the run, for the trace. */
  path: string[];
  text: string;
}

export interface Run {
  approach: Approach;
  design: Design;
  wait: number;
  nights: Night[];
}

export interface Summary {
  approach: Approach;
  delivered: number;
  missing: number;
  corrupt: number;
  retried: number;
  owned: number;
  copied: number;
  waited: number;
}

export interface State {
  design: Design;
  /** Days platform needs to review, merge and release a PR (break-it control). */
  wait: number;
  prediction: Approach | null;
  run: Run | null;
  /** Finished runs, one per approach (the latest one wins). */
  done: Summary[];
}

export type Action =
  | { type: "design"; design: Design }
  | { type: "wait"; days: number }
  | { type: "predict"; approach: Approach }
  | { type: "choose"; approach: Approach }
  | { type: "night" }
  | { type: "finish" }
  | { type: "reset" };

export function init(): State {
  return { design: "switch", wait: 5, prediction: null, run: null, done: [] };
}

export function available(design: Design, a: Approach): boolean {
  return a !== "override" || design === "hook";
}

/** What happens on night n for a given approach. Pure: same inputs, same night. */
export function night(a: Approach, n: number, wait: number): Night {
  const runFrom = a === "fork" ? "billing's copy of run()" : "platform run()";
  const make = a === "override" ? "XlsxExport.createWriter()" : a === "fork" ? 'case "xlsx"' : 'case "xlsx"';
  // The PR path: no xlsx case until platform releases it.
  if (a === "pr" && n <= wait)
    return { n, result: "missing", path: [`night ${n}`, "platform run()", "no xlsx case", "✗"], text: `PR still waiting on platform review. No XLSX export tonight.` };
  const hasFix = a !== "fork" && n >= FIX_NIGHT;
  if (n === CORRUPT_NIGHT) {
    if (hasFix)
      return { n, result: "retried", path: [`night ${n}`, runFrom, make, "upload", "checksum ✗", "retry", "✓"], text: "Upload was truncated. The checksum check caught it and the retry succeeded." };
    return { n, result: "corrupt", path: [`night ${n}`, runFrom, make, "upload", "✓?"], text: a === "fork" ? "Upload was truncated. Your copy of run() predates the checksum fix, so a broken file reached the customer." : "Upload was truncated and nothing checked it. A broken file reached the customer." };
  }
  return { n, result: "ok", path: [`night ${n}`, runFrom, make, "upload", hasFix ? "checksum ✓" : "", "✓"].filter(Boolean), text: hasFix ? "XLSX delivered, checksum verified." : "XLSX delivered." };
}

export function summarize(r: Run): Summary {
  const c = (k: NightResult) => r.nights.filter((x) => x.result === k).length;
  return {
    approach: r.approach,
    delivered: c("ok") + c("retried"),
    missing: c("missing"),
    corrupt: c("corrupt"),
    retried: c("retried"),
    owned: LINES_OWNED[r.approach],
    copied: LINES_COPIED[r.approach],
    waited: r.approach === "pr" ? Math.min(r.wait, r.nights.length) : 0,
  };
}

export const finished = (r: Run | null) => !!r && r.nights.length === NIGHTS;

function advance(r: Run): Run {
  if (r.nights.length >= NIGHTS) return r;
  return { ...r, nights: [...r.nights, night(r.approach, r.nights.length + 1, r.wait)] };
}

function record(st: State, r: Run): State {
  if (!finished(r)) return { ...st, run: r };
  const s = summarize(r);
  return { ...st, run: r, done: [...st.done.filter((d) => d.approach !== s.approach), s] };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "design": {
      // Switching design starts the current experiment over; finished runs stay for comparison.
      const run = st.run && !available(a.design, st.run.approach) ? null : st.run && { ...st.run, design: a.design, nights: [] };
      return { ...st, design: a.design, run };
    }
    case "wait": {
      const days = Math.max(1, Math.min(NIGHTS, Math.round(a.days)));
      return { ...st, wait: days, run: st.run && { ...st.run, wait: days, nights: [] } };
    }
    case "predict":
      return st.prediction ? st : { ...st, prediction: a.approach };
    case "choose":
      if (!available(st.design, a.approach)) return st;
      return { ...st, run: { approach: a.approach, design: st.design, wait: st.wait, nights: [] } };
    case "night":
      return st.run ? record(st, advance(st.run)) : st;
    case "finish": {
      if (!st.run) return st;
      let r = st.run;
      while (r.nights.length < NIGHTS) r = advance(r);
      return record(st, r);
    }
  }
}
