// Purpose. After this, the reader can answer: "Why can't I test the January case (or an empty
// month, or a database outage) of a report that reads the clock and the database itself, and what
// changes when those two are passed in?"
//
// The model: one billing report with three hidden bugs, on two test benches.
// - hard-wired: the report calls the system clock and opens the shared staging database itself.
//   A test gets whatever today is (never January, here) and whatever data other teams left in
//   staging (it grows between runs, so the same assertion flips). Each run costs a network trip.
// - injected: the test passes a clock and an invoice source. The reader picks the date and the
//   data (a fixture, an empty month, a source that fails), so every case is one click away.
// The three bugs: in January the report looks at December of the wrong year; an empty month
// divides by zero; a database error is swallowed and reported as revenue of $0.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type BugId = "january" | "empty" | "outage";
export const BUGS: { id: BugId; title: string; how: string }[] = [
  { id: "january", title: "January looks at the wrong year", how: "Run it on a January date." },
  { id: "empty", title: "An empty month divides by zero", how: "Run it against a month with no invoices." },
  { id: "outage", title: "A database error becomes revenue of $0", how: "Run it with a data source that fails." },
];

export type ClockId = "nov" | "jan";
export type DataId = "fixture" | "empty" | "down";
export interface Day { y: number; m: number; d: number; hh: number; mm: number }
export const CLOCKS: Record<ClockId, { label: string; day: Day }> = {
  nov: { label: "21 Nov 2026", day: { y: 2026, m: 11, d: 21, hh: 10, mm: 0 } },
  jan: { label: "5 Jan 2027", day: { y: 2027, m: 1, d: 5, hh: 9, mm: 0 } },
};
export const DATA_LABEL: Record<DataId, string> = { fixture: "fixture: 5 invoices", empty: "empty month", down: "source that fails" };

export interface Invoice { y: number; m: number; cents: number }
const FIXTURE: Invoice[] = [
  { y: 2026, m: 10, cents: 42000 }, { y: 2026, m: 10, cents: 51000 }, { y: 2026, m: 10, cents: 31000 },
  { y: 2026, m: 12, cents: 50000 }, { y: 2026, m: 12, cents: 33000 },
];
/** Staging belongs to everyone: each run, other teams' tests have added an October invoice. */
const staging = (runs: number): Invoice[] => [
  ...FIXTURE.filter((x) => x.m === 10),
  ...Array.from({ length: runs }, (_, i) => ({ y: 2026, m: 10, cents: 17500 + i * 2500 })),
];

export interface Report { period: string; count: number; totalCents: number; avgCents: number | null }
export interface RunResult {
  id: number;
  bench: "hard" | "inj";
  clock: string;
  data: string;
  /** What the report produced, or the crash. */
  outcome: string;
  ok: boolean;
  /** Bugs this run exposed (compared with what a correct report would do). */
  exposed: BugId[];
  /** Hard-wired only: the same test gave a different answer than last time. */
  flaky: boolean;
  ms: number;
  note: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The report as written, bugs included. */
export function buggyReport(today: Day, source: Invoice[] | "down"): Report | { crash: string } {
  const m = today.m === 1 ? 12 : today.m - 1;
  const y = today.y; // bug: should be today.y - 1 in January
  const rows = source === "down" ? [] : source.filter((x) => x.y === y && x.m === m); // bug: error swallowed
  const total = rows.reduce((a, x) => a + x.cents, 0);
  if (rows.length === 0 && source !== "down") return { crash: "division by zero computing the average invoice" };
  return { period: `${MONTHS[m - 1]} ${y}`, count: rows.length, totalCents: total, avgCents: rows.length ? Math.round(total / rows.length) : null };
}

/** Which bugs a run exposes: the ones whose trigger is present. */
function exposedBy(today: Day, source: Invoice[] | "down"): BugId[] {
  const out: BugId[] = [];
  if (today.m === 1) out.push("january");
  if (source === "down") out.push("outage");
  else {
    const m = today.m === 1 ? 12 : today.m - 1, y = today.m === 1 ? today.y - 1 : today.y;
    const correctRows = source.filter((x) => x.y === y && x.m === m);
    const buggyRows = source.filter((x) => x.y === today.y && x.m === m);
    if (correctRows.length === 0 || buggyRows.length === 0) out.push("empty");
  }
  return out;
}

function describe(r: Report | { crash: string }): { outcome: string; ok: boolean } {
  if ("crash" in r) return { outcome: `Crashed: ${r.crash}.`, ok: false };
  return { outcome: `${r.period}: ${r.count} invoices, ${money(r.totalCents)}, average ${r.avgCents === null ? "n/a" : money(r.avgCents)}.`, ok: true };
}

export interface Bench { count: number; runs: RunResult[]; found: BugId[]; ms: number; flaky: number; dbQueries: number }
const bench = (): Bench => ({ count: 0, runs: [], found: [], ms: 0, flaky: 0, dbQueries: 0 });

export interface State { seq: number; hard: Bench; inj: Bench; clock: ClockId; data: DataId }

export type Action =
  | { type: "runHard" }
  | { type: "runInj" }
  | { type: "clock"; clock: ClockId }
  | { type: "data"; data: DataId }
  | { type: "reset" };

export function init(): State {
  return { seq: 0, hard: bench(), inj: bench(), clock: "nov", data: "fixture" };
}

/** A network round trip to staging, plus connecting: slow, and the same every time. */
export const STAGING_MS = 1150;
export const FAKE_MS = 2;

function record(b: Bench, r: RunResult): Bench {
  const found = [...b.found, ...r.exposed.filter((x) => !b.found.includes(x))];
  return { count: b.count + 1, runs: [r, ...b.runs].slice(0, 8), found, ms: b.ms + r.ms, flaky: b.flaky + (r.flaky ? 1 : 0), dbQueries: b.dbQueries + (r.bench === "hard" ? 1 : 0) };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "clock":
      return { ...st, clock: a.clock };
    case "data":
      return { ...st, data: a.data };

    case "runHard": {
      const k = st.hard.dbQueries; // hard-wired runs so far
      // The real clock: today, a few minutes later each run. Never January.
      const today: Day = { y: 2026, m: 11, d: 21, hh: 10, mm: 2 + k * 3 };
      const source = staging(k);
      const r = buggyReport(today, source);
      const d = describe(r);
      const prev = st.hard.runs[0];
      const flaky = !!prev && prev.outcome !== d.outcome;
      const run: RunResult = {
        id: st.seq + 1, bench: "hard",
        clock: `system clock: 21 Nov 2026 ${String(today.hh).padStart(2, "0")}:${String(today.mm).padStart(2, "0")}`,
        data: `shared staging: ${source.length} October invoices`,
        ...d, exposed: exposedBy(today, source), flaky, ms: STAGING_MS,
        note: flaky
          ? "Same test, different answer: another team's tests added an invoice to staging since your last run."
          : "It ran with today's date and today's staging data. You could not choose either.",
      };
      return { ...st, seq: st.seq + 1, hard: record(st.hard, run) };
    }

    case "runInj": {
      const today = CLOCKS[st.clock].day;
      const source: Invoice[] | "down" = st.data === "down" ? "down" : st.data === "empty" ? [] : FIXTURE;
      const r = buggyReport(today, source);
      const d = describe(r);
      const exposed = exposedBy(today, source);
      // An outage the report hides looks like success; the test sees $0 where it expected an error.
      const ok = d.ok && exposed.length === 0;
      const notes: Record<BugId, string> = {
        january: "Expected December 2026. The report looked at December 2027.",
        empty: "An empty month should give a zero report, not a crash.",
        outage: "The source failed, and the report said revenue was $0. The CFO would get that email.",
      };
      const run: RunResult = {
        id: st.seq + 1, bench: "inj",
        clock: `fake clock: ${CLOCKS[st.clock].label}`,
        data: DATA_LABEL[st.data],
        outcome: d.outcome, ok, exposed, flaky: false, ms: FAKE_MS,
        note: exposed.length ? exposed.map((b) => notes[b]).join(" ") : "Matches the expected report. Run it again: same answer, every time.",
      };
      return { ...st, seq: st.seq + 1, inj: record(st.inj, run) };
    }
  }
}

/** How long until the hard-wired bench could even run the January case, from "today". */
export const DAYS_TO_JANUARY = 41; // 21 Nov 2026 -> 1 Jan 2027
