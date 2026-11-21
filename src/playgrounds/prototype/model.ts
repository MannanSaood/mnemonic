// Prototype playground: clone a job template for two regions, edit the clones, run the jobs.
//
// After this, the reader can answer: when you copy an object to make a new one, which parts
// does the copy share with the original, and why must the object itself decide what to copy
// (the data) and what to share (the HTTP client)?
//
// The heap is drawn like Python Tutor: variables point at job objects, job fields point at an
// env map and an HTTP client. Four ways to "clone": plain assignment (no copy), a shallow copy,
// a deep copy of everything, and the job's own clone() that copies data and shares services.
// Editing one job's DB_HOST shows who else sees the change; running the jobs shows where each
// one writes, and how many connection pools the process now holds.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Mode = "assign" | "shallow" | "deep" | "clone";
export const MODES: Mode[] = ["assign", "shallow", "deep", "clone"];
export type Region = "us" | "eu";
export const REGIONS: Region[] = ["us", "eu"];

export interface Job { id: number; retries: number; env: number; client: number }
export interface Var { name: "template" | Region; job: number }

export interface State {
  mode: Mode;
  vars: Var[];
  jobs: Record<number, Job>;
  envs: Record<number, Record<string, string>>;
  clients: number[];
  nextId: number;
  /** Which objects the last edit touched, to flash them. */
  touched: { env?: number; job?: number } | null;
  /** Variables whose view changed by the last edit, although nobody edited them. */
  surprised: string[];
  prediction: "us-db" | "eu-db" | "template-db" | null;
  ran: RunResult[] | null;
  runs: { mode: Mode; wrong: number; pools: number }[];
}

export interface RunResult { name: string; host: string; expected: string; ok: boolean; retries: number }

export type Action =
  | { type: "mode"; mode: Mode }
  | { type: "clone"; region: Region }
  | { type: "setHost"; region: Region }
  | { type: "setRetries"; region: Region }
  | { type: "predict"; value: "us-db" | "eu-db" | "template-db" }
  | { type: "run" }
  | { type: "reset" };

export const TEMPLATE_HOST = "staging-db.internal";
export const hostFor = (r: Region) => `${r}-db.internal`;

function fresh(mode: Mode): State {
  return {
    mode,
    vars: [{ name: "template", job: 1 }],
    jobs: { 1: { id: 1, retries: 3, env: 2, client: 3 } },
    envs: { 2: { DB_HOST: TEMPLATE_HOST, LOG_LEVEL: "info" } },
    clients: [3],
    nextId: 4,
    touched: null,
    surprised: [],
    prediction: null,
    ran: null,
    runs: [],
  };
}

export function init(): State {
  return fresh("shallow");
}

const varOf = (st: State, name: string) => st.vars.find((v) => v.name === name);

/** Copy the template job the way the current mode does. Returns the new state and the job id. */
function copyTemplate(st: State): { st: State; job: number } {
  const t = st.jobs[varOf(st, "template")!.job];
  let id = st.nextId;
  switch (st.mode) {
    case "assign":
      return { st, job: t.id };
    case "shallow": {
      const job = { ...t, id: id++ };
      return { st: { ...st, jobs: { ...st.jobs, [job.id]: job }, nextId: id }, job: job.id };
    }
    case "deep": {
      const env = id++, client = id++;
      const job = { id: id++, retries: t.retries, env, client };
      return {
        st: { ...st, jobs: { ...st.jobs, [job.id]: job }, envs: { ...st.envs, [env]: { ...st.envs[t.env] } }, clients: [...st.clients, client], nextId: id },
        job: job.id,
      };
    }
    case "clone": {
      // The job knows its own parts: copy the data (env), share the service (client).
      const env = id++;
      const job = { id: id++, retries: t.retries, env, client: t.client };
      return { st: { ...st, jobs: { ...st.jobs, [job.id]: job }, envs: { ...st.envs, [env]: { ...st.envs[t.env] } }, nextId: id }, job: job.id };
    }
  }
}

/** Variables that reach a given env map or job object. */
export function referrers(st: State, target: { env?: number; job?: number }): string[] {
  return st.vars.filter((v) => {
    const j = st.jobs[v.job];
    return target.job !== undefined ? v.job === target.job : j.env === target.env;
  }).map((v) => v.name);
}

/** Env maps or job objects reached by more than one variable. */
export function shared(st: State): { envs: number; jobs: number } {
  const count = (xs: number[]) => xs.filter((x, i) => xs.indexOf(x) !== i).filter((x, i, a) => a.indexOf(x) === i).length;
  return { envs: count(st.vars.map((v) => st.jobs[v.job].env)), jobs: count(st.vars.map((v) => v.job)) };
}

export const hostOf = (st: State, name: string) => {
  const v = varOf(st, name);
  return v ? st.envs[st.jobs[v.job].env].DB_HOST : undefined;
};

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "mode": {
      // Changing how you copy starts the experiment over; earlier runs stay for comparison.
      const s = fresh(a.mode);
      return { ...s, prediction: st.prediction, runs: st.runs };
    }
    case "clone": {
      if (varOf(st, a.region)) return st;
      const { st: s, job } = copyTemplate(st);
      return { ...s, vars: [...s.vars, { name: a.region, job }], touched: null, surprised: [], ran: null };
    }
    case "setHost": {
      const v = varOf(st, a.region);
      if (!v) return st;
      const envId = st.jobs[v.job].env;
      const before = Object.fromEntries(st.vars.map((x) => [x.name, hostOf(st, x.name)]));
      const s = { ...st, envs: { ...st.envs, [envId]: { ...st.envs[envId], DB_HOST: hostFor(a.region) } } };
      const surprised = st.vars.filter((x) => x.name !== a.region && hostOf(s, x.name) !== before[x.name]).map((x) => x.name);
      return { ...s, touched: { env: envId }, surprised, ran: null };
    }
    case "setRetries": {
      const v = varOf(st, a.region);
      if (!v) return st;
      const j = st.jobs[v.job];
      const before = Object.fromEntries(st.vars.map((x) => [x.name, st.jobs[x.job].retries]));
      const s = { ...st, jobs: { ...st.jobs, [j.id]: { ...j, retries: 5 } } };
      const surprised = st.vars.filter((x) => x.name !== a.region && s.jobs[x.job].retries !== before[x.name]).map((x) => x.name);
      return { ...s, touched: { job: j.id }, surprised, ran: null };
    }
    case "predict":
      return st.prediction ? st : { ...st, prediction: a.value };
    case "run": {
      const ran: RunResult[] = st.vars.map((v) => {
        const expected = v.name === "template" ? TEMPLATE_HOST : hostFor(v.name);
        const host = st.envs[st.jobs[v.job].env].DB_HOST;
        return { name: v.name, host, expected, ok: host === expected, retries: st.jobs[v.job].retries };
      });
      const wrong = ran.filter((r) => !r.ok).length;
      const runs = [...st.runs.filter((r) => r.mode !== st.mode), { mode: st.mode, wrong, pools: st.clients.length }];
      return { ...st, ran, runs, touched: null };
    }
  }
}

/** The guided scenario: clone for both regions, give each its own database, run. */
export const SCENARIO: Action[] = [
  { type: "clone", region: "us" },
  { type: "setHost", region: "us" },
  { type: "clone", region: "eu" },
  { type: "setHost", region: "eu" },
  { type: "run" },
];
