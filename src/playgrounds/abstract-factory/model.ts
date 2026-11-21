// Abstract Factory playground: wire a service's storage, queue and secrets, then send an upload.
//
// After this, the reader can answer: why does choosing the whole cloud family in one place
// make the dangerous wirings impossible, and what does that cost when a new kind of product
// (a cache) is added?
//
// The service: the API stores an upload in object storage, storage notifies a queue, a worker
// reads the database password from the secrets store, then processes the file. Each product
// needs credentials for the cloud the service runs in, and storage can only notify a queue of
// its own cloud (S3 -> SQS, GCS -> Pub/Sub, Blob Storage -> Queue Storage via Event Grid).
// With three separate settings, most wirings fail, and one class of them fails silently.
// With one factory per cloud, only whole families exist.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Cloud = "aws" | "gcp" | "azure";
export type Slot = "storage" | "queue" | "secrets";
export const SLOTS: Slot[] = ["storage", "queue", "secrets"];
export type Design = "settings" | "factory";
export type Wiring = Record<Slot, Cloud>;

export const CLOUD_NAME: Record<Cloud, string> = { aws: "AWS", gcp: "GCP", azure: "Azure" };
export const PRODUCT: Record<Cloud, Record<Slot, string>> = {
  aws: { storage: "S3", queue: "SQS", secrets: "Secrets Manager" },
  gcp: { storage: "GCS", queue: "Pub/Sub", secrets: "Secret Manager" },
  azure: { storage: "Blob Storage", queue: "Queue Storage", secrets: "Key Vault" },
};

/** What the person who uploaded the file experiences. */
export type Outcome = "processed" | "upload-error" | "silent" | "crashloop";
export const OUTCOME_TEXT: Record<Outcome, string> = {
  processed: "File processed.",
  "upload-error": "Upload fails with an error. Loud: the user sees it, alerts fire.",
  silent: "Upload succeeds, then nothing happens. Silent: no error anywhere, the file is never processed.",
  crashloop: "Upload succeeds, but the worker crash-loops on startup. The file waits until someone fixes it.",
};

export interface Hop { label: string; ok: boolean; note: string }
export interface Trace { wiring: Wiring; env: Cloud; hops: Hop[]; outcome: Outcome }

export interface ChangeCost { places: number; newTypes: number; text: string }

export interface State {
  design: Design;
  env: Cloud;
  clouds: Cloud[];
  /** The three settings (design "settings"). In design "factory" all three are always equal. */
  wiring: Wiring;
  prediction: Outcome | null;
  last: Trace | null;
  sent: number;
  /** Outcome per wiring key, per design, for the wirings the reader has tried. */
  tried: Record<Design, Record<string, Outcome>>;
  /** Change requests the reader has applied: what each cost in each design. */
  azureCost: Record<Design, ChangeCost> | null;
  cacheCost: Record<Design, ChangeCost> | null;
}

export type Action =
  | { type: "design"; design: Design }
  | { type: "env"; env: Cloud }
  | { type: "set"; slot: Slot; cloud: Cloud }
  | { type: "predict"; outcome: Outcome }
  | { type: "send" }
  | { type: "addAzure" }
  | { type: "addCache" }
  | { type: "reset" };

/** The staging config halfway through a migration from AWS to GCP: the queue was missed. */
const START: Wiring = { storage: "gcp", queue: "aws", secrets: "gcp" };

export function init(): State {
  return {
    design: "settings", env: "gcp", clouds: ["aws", "gcp"], wiring: { ...START }, prediction: null, last: null, sent: 0,
    tried: { settings: {}, factory: {} }, azureCost: null, cacheCost: null,
  };
}

export const key = (w: Wiring) => SLOTS.map((s) => w[s]).join("/");
export const isFamily = (w: Wiring) => w.storage === w.queue && w.queue === w.secrets;

/** Wirings the config can express, and how many of them work where the service runs. */
export function space(st: State): { possible: number; working: number } {
  const k = st.clouds.length;
  return { possible: st.design === "settings" ? k ** 3 : k, working: 1 };
}

/** Every wiring the current design allows, in a stable order (for the map of tried wirings). */
export function allWirings(st: State): Wiring[] {
  const cs = st.clouds;
  if (st.design === "factory") return cs.map((c) => ({ storage: c, queue: c, secrets: c }));
  return cs.flatMap((s) => cs.flatMap((q) => cs.map((x) => ({ storage: s, queue: q, secrets: x }))));
}

/** One upload through the service. Pure. */
export function trace(w: Wiring, env: Cloud): Trace {
  const hops: Hop[] = [];
  const creds = (c: Cloud) => c === env;
  const st = PRODUCT[w.storage].storage, q = PRODUCT[w.queue].queue, sec = PRODUCT[w.secrets].secrets;
  // 1. API stores the upload.
  if (!creds(w.storage)) {
    hops.push({ label: `put → ${st}`, ok: false, note: `403: the service runs in ${CLOUD_NAME[env]} and has no ${CLOUD_NAME[w.storage]} credentials.` });
    return { wiring: w, env, hops, outcome: "upload-error" };
  }
  hops.push({ label: `put → ${st}`, ok: true, note: "Stored. The user gets 200 OK." });
  // 2. Storage notifies the queue: only within one cloud.
  if (w.queue !== w.storage) {
    hops.push({ label: `${st} → ${q}`, ok: false, note: `${st} sends upload events only to ${PRODUCT[w.storage].queue}. No event reaches ${q}, and nothing logs an error.` });
    return { wiring: w, env, hops, outcome: "silent" };
  }
  hops.push({ label: `${st} → ${q}`, ok: true, note: "Upload event queued." });
  // 3. Worker starts and reads the database password.
  if (!creds(w.secrets)) {
    hops.push({ label: `worker → ${sec}`, ok: false, note: `The worker cannot read ${sec} without ${CLOUD_NAME[w.secrets]} credentials, exits, and restarts in a loop.` });
    return { wiring: w, env, hops, outcome: "crashloop" };
  }
  hops.push({ label: `worker → ${sec}`, ok: true, note: "Database password read." });
  hops.push({ label: `worker → ${st}`, ok: true, note: "File fetched and processed." });
  return { wiring: w, env, hops, outcome: "processed" };
}

/** What a change request costs in each design, given how many clouds exist (k). */
export function costs(kind: "azure" | "cache", k: number): Record<Design, ChangeCost> {
  if (kind === "azure")
    return {
      settings: { places: 3, newTypes: 0, text: "1 new case in each of 3 switches" },
      factory: { places: 0, newTypes: 1, text: "1 new factory type, 0 edits" },
    };
  return {
    settings: { places: 1, newTypes: 0, text: `1 new switch with ${k} cases, and 1 more setting to get wrong` },
    factory: { places: k + 1, newTypes: 0, text: `1 new method on the interface + 1 in each of ${k} factories` },
  };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "design": {
      // Moving to the factory design: the family is whatever the storage setting was.
      const wiring = a.design === "factory" ? { storage: st.wiring.storage, queue: st.wiring.storage, secrets: st.wiring.storage } : st.wiring;
      return { ...st, design: a.design, wiring, last: null };
    }
    case "env":
      return st.clouds.includes(a.env) ? { ...st, env: a.env, last: null } : st;
    case "set": {
      if (!st.clouds.includes(a.cloud)) return st;
      const wiring = st.design === "factory" ? { storage: a.cloud, queue: a.cloud, secrets: a.cloud } : { ...st.wiring, [a.slot]: a.cloud };
      return { ...st, wiring, last: null };
    }
    case "predict":
      return st.prediction ? st : { ...st, prediction: a.outcome };
    case "send": {
      const t = trace(st.wiring, st.env);
      const tried = { ...st.tried, [st.design]: { ...st.tried[st.design], [key(st.wiring)]: t.outcome } };
      return { ...st, last: t, sent: st.sent + 1, tried };
    }
    case "addAzure":
      if (st.clouds.includes("azure")) return st;
      return { ...st, clouds: [...st.clouds, "azure"], azureCost: costs("azure", st.clouds.length), last: null };
    case "addCache":
      if (st.cacheCost) return st;
      return { ...st, cacheCost: costs("cache", st.clouds.length) };
  }
}
