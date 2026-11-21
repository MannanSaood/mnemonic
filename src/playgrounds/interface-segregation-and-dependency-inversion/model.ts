// Purpose: after this, the reader can answer: "Which change stops at the module that asked for
// it?" Segregated interfaces stop a change to one client's needs from reaching the others;
// inverted dependencies stop a change in the database layer from reaching the business code.
// You need both, and the playground shows what each one buys on its own.
//
// Four services use one user store backed by Postgres. Two switches build four designs:
// ISP (each service sees the whole UserRepository, or only the methods it uses) and DIP (the
// interface lives in package postgres, or in the service that uses it). The reader ships four
// real change requests and watches the ripple: which modules are edited, which are rebuilt,
// which test fakes must change. A 2x2 grid always shows the same request in all four designs.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Service = "signup" | "admin" | "gdpr" | "stats";
export const SERVICES: Service[] = ["signup", "admin", "gdpr", "stats"];
export type Mod = Service | "users" | "postgres" | "pgx" | "memstore" | "main";

export const SERVICE: Record<Service, { name: string; iface: string; methods: string[] }> = {
  signup: { name: "SignupService", iface: "SignupStore", methods: ["FindByEmail", "Create"] },
  admin: { name: "AdminConsole", iface: "AdminStore", methods: ["Ban", "List", "Search"] },
  gdpr: { name: "GdprExporter", iface: "GdprStore", methods: ["FindByID", "ExportAll", "Delete"] },
  stats: { name: "SignupStats", iface: "SignupCounter", methods: ["CountSignups"] },
};
/** The fat interface: every method any service needs, plus UpdatePassword for the account page. */
export const FAT_METHODS = ["FindByID", "FindByEmail", "Create", "UpdatePassword", "Ban", "List", "Search", "CountSignups", "ExportAll", "Delete"];

export type EventId = "bulkBan" | "pgx" | "memstore" | "test";
export const EVENTS: Record<EventId, { title: string; who: string; why: string; requester: Service | null }> = {
  bulkBan: { title: "Admins need BulkBan", who: "Trust & Safety", why: "Ban a spam wave of accounts in one call.", requester: "admin" },
  pgx: { title: "Upgrade pgx v4 to v5", who: "Platform team", why: "The old driver is out of support.", requester: null },
  memstore: { title: "Signup on an in-memory store", who: "Developer experience", why: "Local dev should run without Postgres.", requester: null },
  test: { title: "Unit-test SignupService", who: "You", why: "Cover the duplicate-email path.", requester: null },
};
export const EVENT_IDS: EventId[] = ["bulkBan", "pgx", "memstore", "test"];

export interface Design { isp: boolean; dip: boolean }
export const DESIGNS: Design[] = [
  { isp: false, dip: false }, { isp: true, dip: false },
  { isp: false, dip: true }, { isp: true, dip: true },
];
export const designName = (d: Design) =>
  `${d.isp ? "Role interfaces" : "One fat interface"}, ${d.dip ? "owned by the services" : "owned by postgres"}`;

/** Source-code dependencies: who imports whom. */
export function deps(d: Design, withMem: boolean): Record<string, Mod[]> {
  const g: Record<string, Mod[]> = {};
  if (!d.dip) {
    for (const s of SERVICES) g[s] = ["postgres"];
    g.signup = ["postgres", "pgx"]; // it checks the driver's unique-violation error itself
    g.postgres = ["pgx"];
    if (withMem) g.memstore = ["postgres"];
  } else if (!d.isp) {
    for (const s of SERVICES) g[s] = ["users"];
    g.users = [];
    g.postgres = ["users", "pgx"];
    if (withMem) g.memstore = ["users"];
  } else {
    for (const s of SERVICES) g[s] = [];
    g.postgres = [...SERVICES, "pgx"];
    if (withMem) g.memstore = ["signup"];
  }
  g.pgx = [];
  g.main = Object.keys(g).filter((m) => m !== "main") as Mod[];
  return g;
}

export interface Ripple {
  edited: Mod[];
  rebuilt: Mod[];
  created: Mod[];
  /** test fakes that must change */
  fakesEdited: Service[];
  /** services rebuilt that did not ask for this change */
  bystanders: Service[];
  /** services whose source had to change although they asked for nothing */
  unasked: Service[];
  /** for "test": methods the SignupService fake must implement; for "memstore": methods to write */
  methods: number;
  /** for "test": the unit test has to import the Postgres driver */
  driverInTest: boolean;
}

export function ripple(d: Design, e: EventId): Ripple {
  const ifaceHome: Mod = d.dip ? (d.isp ? "admin" : "users") : "postgres";
  let edited: Mod[] = [];
  let created: Mod[] = [];
  let fakesEdited: Service[] = [];
  let methods = 0;
  let driverInTest = false;
  switch (e) {
    case "bulkBan":
      edited = [...new Set<Mod>([ifaceHome, "postgres", "admin"])];
      // every fake implements the interface its service sees
      fakesEdited = d.isp ? ["admin"] : [...SERVICES];
      break;
    case "pgx":
      edited = d.dip ? ["pgx", "postgres"] : ["pgx", "postgres", "signup"];
      fakesEdited = d.dip ? [] : ["signup"]; // the fake builds a pgconn.PgError
      break;
    case "memstore":
      created = ["memstore"];
      edited = d.dip ? [] : ["signup"]; // must also recognise the new store's duplicate error
      methods = d.isp ? SERVICE.signup.methods.length : FAT_METHODS.length;
      break;
    case "test":
      methods = d.isp ? SERVICE.signup.methods.length : FAT_METHODS.length;
      driverInTest = !d.dip;
      break;
  }
  const g = deps(d, e === "memstore");
  const rebuilt = new Set<Mod>([...edited, ...created]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [m, ds] of Object.entries(g))
      if (!rebuilt.has(m as Mod) && ds.some((x) => rebuilt.has(x))) { rebuilt.add(m as Mod); grew = true; }
  }
  const req = EVENTS[e].requester;
  const bystanders = SERVICES.filter((s) => rebuilt.has(s) && s !== req);
  const unasked = SERVICES.filter((s) => edited.includes(s) && s !== req);
  return { edited, rebuilt: [...rebuilt], created, fakesEdited, bystanders, unasked, methods, driverInTest };
}

export interface Totals { bystanders: number; unasked: number; fakesEdited: number; fakeMethods: number; memMethods: number; driverInTest: boolean }
export function totals(d: Design): Totals {
  const r = Object.fromEntries(EVENT_IDS.map((e) => [e, ripple(d, e)])) as Record<EventId, Ripple>;
  return {
    bystanders: EVENT_IDS.reduce((n, e) => n + r[e].bystanders.length, 0),
    unasked: EVENT_IDS.reduce((n, e) => n + r[e].unasked.length, 0),
    fakesEdited: EVENT_IDS.reduce((n, e) => n + r[e].fakesEdited.length, 0),
    fakeMethods: r.test.methods,
    memMethods: r.memstore.methods,
    driverInTest: r.test.driverInTest,
  };
}

/* ---------------- state ---------------- */

export type Predict = "1" | "2" | "4";
export const PREDICT_ANSWER: Predict = "4";

export interface State {
  design: Design;
  event: EventId | null;
  /** events shipped in each design, keyed by designKey */
  shipped: Record<string, EventId[]>;
  predict: Predict | null;
}
export const designKey = (d: Design) => `${d.isp ? "isp" : "fat"}-${d.dip ? "dip" : "concrete"}`;

export type Action =
  | { type: "isp"; on: boolean }
  | { type: "dip"; on: boolean }
  | { type: "design"; design: Design }
  | { type: "ship"; event: EventId }
  | { type: "predict"; value: Predict }
  | { type: "reset" };

export function init(): State {
  return { design: { isp: false, dip: false }, event: null, shipped: {}, predict: null };
}

/** The prediction is about the fat interface; it is answered once BulkBan ships in a fat design. */
export const predictRevealed = (s: State) =>
  Object.entries(s.shipped).some(([k, es]) => k.startsWith("fat") && es.includes("bulkBan"));

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "isp":
      return { ...s, design: { ...s.design, isp: a.on } };
    case "dip":
      return { ...s, design: { ...s.design, dip: a.on } };
    case "design":
      return { ...s, design: a.design };
    case "ship": {
      const k = designKey(s.design);
      const done = s.shipped[k] ?? [];
      return { ...s, event: a.event, shipped: { ...s.shipped, [k]: done.includes(a.event) ? done : [...done, a.event] } };
    }
    case "predict":
      return predictRevealed(s) ? s : { ...s, predict: a.value };
  }
}
