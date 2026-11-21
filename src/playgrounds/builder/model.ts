// Builder playground: review one call that creates a Kubernetes Deployment, then ship it.
//
// After this, the reader can answer: why does a positional constructor let same-typed
// arguments swap silently, and how do named steps plus one validating build() stop a wrong
// object from ever existing?
//
// The ticket says: checkout-api, image shop/checkout:2.3, 3 replicas, port 8080, 500m CPU,
// 256Mi memory, readiness probe /healthz. The call under review passes every argument, in the
// wrong order. The compiler cannot see it, because the swapped arguments share a type. The
// reader swaps argument chips to fix it, and applies the result to a simulated cluster, which
// says what Kubernetes understood. In the builder design every value sits next to its name,
// and build() checks the object as a whole before anything leaves the laptop.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Field = "name" | "image" | "replicas" | "port" | "cpu" | "memory" | "probe";
/** Positional order of the constructor's parameters. */
export const SIG: Field[] = ["name", "image", "replicas", "port", "cpu", "memory", "probe"];
export const TYPE: Record<Field, "string" | "int"> = { name: "string", image: "string", replicas: "int", port: "int", cpu: "string", memory: "string", probe: "string" };
/** What the ticket asked for. */
export const MEANT: Record<Field, string> = { name: "checkout-api", image: "shop/checkout:2.3", replicas: "3", port: "8080", cpu: "500m", memory: "256Mi", probe: "/healthz" };

export type Design = "positional" | "builder";

export interface Effect { field: Field; got: string; ok: boolean; text: string }
export interface Attempt { design: Design; kind: "apply" | "build"; effects: Effect[]; reached: boolean; healthy: boolean }

export interface State {
  design: Design;
  /** args[i] is the value passed in position i (positional) or to step SIG[i] (builder). */
  args: string[];
  selected: number | null;
  showNames: boolean;
  prediction: "3" | "8080" | "compile" | null;
  attempts: Attempt[];
  swaps: number;
}

export type Action =
  | { type: "design"; design: Design }
  | { type: "pick"; index: number }
  | { type: "names" }
  | { type: "predict"; value: "3" | "8080" | "compile" }
  | { type: "apply" }
  | { type: "build" }
  | { type: "reset" };

/** The call that passed review: replicas and port swapped, cpu and memory swapped. */
const START = ["checkout-api", "shop/checkout:2.3", "8080", "3", "256Mi", "500m", "/healthz"];

export function init(): State {
  return { design: "positional", args: [...START], selected: null, showNames: false, prediction: null, attempts: [], swaps: 0 };
}

/* ---------------- what Kubernetes makes of a value ---------------- */

const UNITS: Record<string, number> = { m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 };
/** Parse a Kubernetes quantity. Returns null if it is not one. */
export function quantity(s: string): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)(m|k|M|G|Ki|Mi|Gi)?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * UNITS[m[2] ?? ""];
}
const fmt = (n: number) => n >= 1e6 ? Math.round(n).toLocaleString("en-US") : String(+n.toPrecision(3));
const NODE_CPU = 64;
const MIN_MEMORY = 4 * 1024 ** 2;

export function effect(field: Field, got: string): Effect {
  const ok = got === MEANT[field];
  const e = (text: string, good = ok): Effect => ({ field, got, ok: good, text });
  switch (field) {
    case "name":
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(got)) return e(`Rejected by the API server: "${got}" is not a valid name.`, false);
      return e(ok ? "Deployment checkout-api." : `Created under the wrong name, "${got}".`);
    case "image":
      if (!/^[a-z0-9./-]+:[\w.-]+$/.test(got)) return e(`No image called "${got}": pods stick in ImagePullBackOff.`, false);
      return e(ok ? "Pulls shop/checkout:2.3." : `Runs the wrong image, ${got}.`);
    case "replicas": {
      const n = Number(got);
      if (n > 50) return e(`${fmt(n)} pods requested. A few dozen fit; the rest sit Pending while the autoscaler orders nodes.`, false);
      return e(ok ? "3 pods." : `${n} pods.`);
    }
    case "port":
      return ok ? e("Traffic goes to 8080, where the app listens.") : e(`The Service sends traffic to port ${got}. Nothing listens there, so every request is refused.`, false);
    case "cpu": {
      const q = quantity(got);
      if (q === null) return e(`Rejected: "${got}" is not a quantity.`, false);
      if (q > NODE_CPU) return e(`Asks for ${fmt(q)} CPU cores. No node is that big: every pod stays Pending (Insufficient cpu).`, false);
      return e(ok ? "Half a core each." : `${fmt(q)} cores each.`);
    }
    case "memory": {
      const q = quantity(got);
      if (q === null) return e(`Rejected: "${got}" is not a quantity.`, false);
      if (q < MIN_MEMORY) return e(`A memory limit of ${fmt(q)} bytes ("m" means milli). No process fits; the container is killed as soon as it starts.`, false);
      return e(ok ? "256 MiB each." : `${fmt(q / 1024 ** 2)} MiB each.`);
    }
    case "probe":
      return got.startsWith("/") ? e(ok ? "Ready once /healthz answers." : `Probes ${got}.`) : e(`Readiness probe on "${got}" never succeeds: pods never get traffic.`, false);
  }
}

export function effects(args: string[]): Effect[] {
  return SIG.map((f, i) => effect(f, args[i]));
}

/** build(): the checks a builder runs on the whole object before it exists. */
export function validate(args: string[]): string[] {
  const v: Record<Field, string> = Object.fromEntries(SIG.map((f, i) => [f, args[i]])) as Record<Field, string>;
  const errs: string[] = [];
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v.name)) errs.push(`name "${v.name}" is not a valid DNS label`);
  if (!/^[a-z0-9./-]+:[\w.-]+$/.test(v.image)) errs.push(`image "${v.image}" has no tag`);
  const r = Number(v.replicas);
  if (!(r >= 1 && r <= 50)) errs.push(`replicas ${v.replicas} is outside 1..50`);
  const p = Number(v.port);
  if (!(p >= 1 && p <= 65535)) errs.push(`port ${v.port} is out of range`);
  const c = quantity(v.cpu);
  if (c === null || c > NODE_CPU) errs.push(`cpu ${v.cpu} is more than a node has`);
  const m = quantity(v.memory);
  if (m === null || m < MIN_MEMORY) errs.push(`memory ${v.memory} is below 4Mi (did you mean Mi?)`);
  if (!v.probe.startsWith("/")) errs.push(`probe "${v.probe}" is not a path`);
  return errs;
}

export const allCorrect = (args: string[]) => SIG.every((f, i) => args[i] === MEANT[f]);

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "design":
      return { ...st, design: a.design, selected: null };
    case "names":
      return { ...st, showNames: !st.showNames };
    case "predict":
      return st.prediction ? st : { ...st, prediction: a.value };
    case "pick": {
      const i = a.index;
      if (i < 0 || i >= SIG.length) return st;
      if (st.selected === null) return { ...st, selected: i };
      if (st.selected === i) return { ...st, selected: null };
      // Only same-typed arguments can trade places: anything else would not compile.
      if (TYPE[SIG[st.selected]] !== TYPE[SIG[i]]) return { ...st, selected: i };
      const args = [...st.args];
      [args[st.selected], args[i]] = [args[i], args[st.selected]];
      return { ...st, args, selected: null, swaps: st.swaps + 1 };
    }
    case "apply": {
      // Positional: no build step, the object goes straight to the cluster.
      if (st.design !== "positional") return st;
      const eff = effects(st.args);
      return { ...st, selected: null, attempts: [...st.attempts, { design: "positional", kind: "apply", effects: eff, reached: true, healthy: eff.every((x) => x.ok) }] };
    }
    case "build": {
      if (st.design !== "builder") return st;
      const errs = validate(st.args);
      const eff = effects(st.args);
      const reached = errs.length === 0;
      return { ...st, selected: null, attempts: [...st.attempts, { design: "builder", kind: "build", effects: eff, reached, healthy: reached && eff.every((x) => x.ok) }] };
    }
  }
}

export function tally(st: State) {
  const pos = st.attempts.filter((x) => x.design === "positional");
  const bld = st.attempts.filter((x) => x.design === "builder");
  return {
    brokenRollouts: st.attempts.filter((x) => x.reached && !x.healthy).length,
    caughtByBuild: bld.filter((x) => !x.reached).length,
    positionalApplies: pos.length,
    builds: bld.length,
    healthy: st.attempts.filter((x) => x.healthy).length,
  };
}
