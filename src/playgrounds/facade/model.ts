// Facade playground: four callers deploy a service by driving a seven-part deploy subsystem.
// The platform team keeps changing that subsystem; every change has to reach every script that
// runs the steps by hand.
//
// After this, the reader can answer: why does putting the order of the deploy steps behind one
// Deploy() call make subsystem changes cost one edit instead of one per caller, and why must the
// facade stay optional? (Callers that are missed fail, some of them silently; and the rollback
// script, which needs a different sequence, breaks if you force it through the facade.)
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Caller = "ci" | "chatops" | "hotfix" | "rollback";
export const CALLERS: Caller[] = ["ci", "chatops", "hotfix", "rollback"];
export const CALLER_NAME: Record<Caller, string> = { ci: "CI pipeline", chatops: "ChatOps /deploy", hotfix: "hotfix script", rollback: "rollback script" };
export const CALLER_FILE: Record<Caller, string> = { ci: "ci/deploy", chatops: "bot/deploy", hotfix: "scripts/hotfix", rollback: "scripts/rollback" };

export type Part = "build" | "scan" | "registry" | "migrate" | "cluster" | "cdn" | "notify";
export const PARTS: Part[] = ["build", "scan", "registry", "migrate", "cluster", "cdn", "notify"];
export const PART_NAME: Record<Part, string> = {
  build: "Builder", scan: "Scanner", registry: "Registry", migrate: "Migrator", cluster: "Cluster", cdn: "CDN", notify: "Notifier",
};

export type File = Caller | "facade";

/** The change requests from the platform team, in order. */
export const CHANGES = [
  {
    title: "Scan every image before it is pushed",
    why: "Security wants every image scanned for known CVEs. The new Scanner must run between build and push.",
    missed: "silent" as const,
  },
  {
    title: "The registry moved: push now needs a region",
    why: "Images move from Docker Hub to a regional registry. Registry.Push takes a region argument; the old signature is gone.",
    missed: "loud" as const,
  },
  {
    title: "Announcements need the release tag",
    why: "Notifier.Send(text) is replaced by Notifier.Announce(release). Every script that announces a deploy must switch.",
    missed: "loud" as const,
  },
];
export type ChangeIdx = 0 | 1 | 2;

export interface DeployEvent { id: number; caller: Caller; ok: boolean; silent: boolean; path: string[]; text: string }
export interface ChangeResult { edits: number; late: number; best: number; broken: number; silent: number; files: File[] }

export interface State {
  /** 0..2: the change in progress. 3: all done. */
  change: number;
  via: Record<Caller, boolean>;
  /** Which change requests each file's code has absorbed. */
  applied: Record<File, number[]>;
  /** Files edited during the current change. */
  edited: File[];
  /** Files opened during the current change that turned out not to need the change. */
  looked: File[];
  /** Deploys shipped during the current change, and what went wrong in them. */
  ships: number;
  broken: number;
  silent: number;
  refactors: number;
  lastRun: DeployEvent[];
  results: ChangeResult[];
  seq: number;
}

export type Action =
  | { type: "route"; caller: Caller }
  | { type: "edit"; file: File }
  | { type: "ship" }
  | { type: "next" }
  | { type: "reset" };

export function init(): State {
  return {
    change: 0,
    via: { ci: false, chatops: false, hotfix: false, rollback: false },
    applied: { ci: [], chatops: [], hotfix: [], rollback: [], facade: [] },
    edited: [], looked: [], ships: 0, broken: 0, silent: 0, refactors: 0, lastRun: [], results: [], seq: 1,
  };
}

/* ---------------- what each script does ---------------- */

/** The rollback needs a different sequence: no build, no scan, and above all no forward migrations. */
export function partsUsed(file: File, changesSoFar: number): Part[] {
  const scan = changesSoFar >= 1 ? ["scan" as Part] : [];
  if (file === "rollback") return ["cluster", "cdn", "notify"];
  return ["build", ...scan, "registry", "migrate", "cluster", "cdn", "notify"];
}

/** Does change c touch this file's code? (The facade is affected only if someone uses it.) */
export function touches(st: State, file: File, c: number): boolean {
  if (file === "facade") return CALLERS.some((k) => st.via[k]);
  if (st.via[file]) return false;
  if (file === "rollback") return c === 2;
  return true;
}

/** Files that must change for the current change request. */
export function mustEdit(st: State): File[] {
  if (st.change > 2) return [];
  return ([...CALLERS, "facade"] as File[]).filter((f) => touches(st, f, st.change));
}

/** Fewest edits this change could have cost: the facade, plus the rollback if the change reaches it. */
export const best = (c: number) => (c === 2 ? 2 : 1);

/** The number of caller-to-subsystem dependencies: what has to be checked when the subsystem changes. */
export function wires(st: State): number {
  const n = Math.min(st.change, 2) + (st.change > 2 ? 1 : 0);
  let w = 0;
  for (const c of CALLERS) w += st.via[c] ? 1 : partsUsed(c, n).length;
  if (CALLERS.some((c) => st.via[c])) w += partsUsed("facade", n).length;
  return w;
}

function runDeploy(st: State, caller: Caller, id: number): DeployEvent {
  const viaFacade = st.via[caller];
  const file: File = viaFacade ? "facade" : caller;
  const has = (c: number) => c > st.change || st.applied[file].includes(c);
  const head = viaFacade ? [CALLER_NAME[caller], "Deployer.Deploy"] : [CALLER_NAME[caller]];

  if (caller === "rollback" && viaFacade)
    return { id, caller, ok: false, silent: false, path: [...head, "build main", "migrate ↑", "✗"], text: "The rollback went through Deploy(): it rebuilt from main and ran the migrations forward, the opposite of a rollback. Incident." };

  const steps: string[] = [];
  if (caller !== "rollback") {
    steps.push("build");
    if (has(0)) steps.push("scan");
    if (!has(1) && st.change >= 1) return { id, caller, ok: false, silent: false, path: [...head, ...steps, "push ✗"], text: `${CALLER_NAME[caller]} failed at push: Registry.Push now needs a region.` };
    steps.push("push", "migrate");
  }
  steps.push(caller === "rollback" ? "rollout (previous)" : "rollout", "purge");
  if (!has(2) && st.change >= 2) return { id, caller, ok: false, silent: false, path: [...head, ...steps, "notify ✗"], text: `${CALLER_NAME[caller]} deployed, then failed: Notifier.Send no longer exists. Nobody was told about the release.` };
  steps.push("notify");
  if (!has(0) && caller !== "rollback")
    return { id, caller, ok: true, silent: true, path: [...head, ...steps, "✓?"], text: `${CALLER_NAME[caller]} reported success. It never ran the scanner, so an unscanned image is in production and nothing says so.` };
  return { id, caller, ok: true, silent: false, path: [...head, ...steps, "✓"], text: `${CALLER_NAME[caller]} deployed cleanly${viaFacade ? " through the facade" : ""}.` };
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();

    case "route": {
      if (st.change > 2) return st;
      const on = !st.via[a.caller];
      const via = { ...st.via, [a.caller]: on };
      // Routing a caller is an edit to its file. Going back to direct means writing the steps again,
      // against today's subsystem, so the script is up to date.
      const applied = { ...st.applied };
      if (!on) applied[a.caller] = [0, 1, 2].filter((c) => c < st.change);
      // The facade starts out current with every change already shipped.
      if (on && !CALLERS.some((c) => st.via[c])) applied.facade = [0, 1, 2].filter((c) => c < st.change);
      return { ...st, via, applied, refactors: st.refactors + 1 };
    }

    case "edit": {
      if (st.change > 2 || st.edited.includes(a.file) || st.looked.includes(a.file)) return st;
      if (!touches(st, a.file, st.change)) return { ...st, looked: [...st.looked, a.file] };
      return {
        ...st,
        edited: [...st.edited, a.file],
        applied: { ...st.applied, [a.file]: [...st.applied[a.file], st.change] },
      };
    }

    case "ship": {
      if (st.change > 2) return st;
      let id = st.seq;
      const run = CALLERS.map((c) => runDeploy(st, c, id++));
      return {
        ...st, seq: id, lastRun: run, ships: st.ships + 1,
        broken: st.broken + run.filter((e) => !e.ok).length,
        silent: st.silent + run.filter((e) => e.silent).length,
      };
    }

    case "next": {
      if (st.change > 2 || st.ships === 0) return st;
      // Files still missing the change get fixed afterwards, once someone notices. They count as late edits.
      const late = mustEdit(st).filter((f) => !st.edited.includes(f));
      const result: ChangeResult = { edits: st.edited.length + late.length, late: late.length, best: best(st.change), broken: st.broken, silent: st.silent, files: [...st.edited, ...late] };
      const applied = { ...st.applied };
      for (const f of [...CALLERS, "facade"] as File[]) if (!applied[f].includes(st.change)) applied[f] = [...applied[f], st.change];
      return { ...st, change: st.change + 1, applied, edited: [], looked: [], ships: 0, broken: 0, silent: 0, lastRun: [], results: [...st.results, result] };
    }
  }
}
