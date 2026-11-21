"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BUGS, CLOCKS, DATA_LABEL, DAYS_TO_JANUARY, init, step,
  type Bench, type ClockId, type DataId, type RunResult,
} from "./model";

const HARD: Record<Lang, string[]> = {
  go: ["func MonthlyRevenue() (Report, error) {", "    now := time.Now()", "    db, err := sql.Open(\"postgres\", os.Getenv(\"BILLING_DB_URL\"))"],
  python: ["def monthly_revenue() -> Report:", "    now = datetime.now(UTC)", "    db = psycopg.connect(os.environ[\"BILLING_DB_URL\"])"],
  typescript: ["async function monthlyRevenue(): Promise<Report> {", "  const now = new Date();", "  const db = new Pool({ connectionString: process.env.BILLING_DB_URL });"],
  rust: ["async fn monthly_revenue() -> Result<Report> {", "    let now = Utc::now();", "    let db = PgPool::connect(&env::var(\"BILLING_DB_URL\")?).await?;"],
};
const INJ: Record<Lang, string[]> = {
  go: ["func MonthlyRevenue(now time.Time, inv InvoiceSource) (Report, error) {", "    // no clock, no connection: both arrive as arguments"],
  python: ["def monthly_revenue(now: datetime, invoices: InvoiceSource) -> Report:", "    # no clock, no connection: both arrive as arguments"],
  typescript: ["async function monthlyRevenue(now: Date, invoices: InvoiceSource): Promise<Report> {", "  // no clock, no connection: both arrive as arguments"],
  rust: ["async fn monthly_revenue(now: DateTime<Utc>, invoices: &impl InvoiceSource) -> Result<Report> {", "    // no clock, no connection: both arrive as arguments"],
};

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function Stats({ b }: { b: Bench }) {
  return (
    <dl className="pg-stats">
      <div><dt>Runs</dt><dd>{b.count}</dd></div>
      <div><dt>Bugs found</dt><dd>{b.found.length} of 3</dd></div>
      <div className={b.flaky ? "bad" : ""}><dt>Flaky answers</dt><dd>{b.flaky}</dd></div>
      <div><dt>Time spent</dt><dd>{secs(b.ms)}</dd></div>
    </dl>
  );
}

function Runs({ runs, reduced, empty }: { runs: RunResult[]; reduced: boolean; empty: string }) {
  if (!runs.length) return <p className="pg-empty">{empty}</p>;
  return (
    <div className="pg-log" aria-live="polite">
      {runs.map((r, i) => (
        <div key={r.id} className={"pg-entry" + (r.ok && !r.flaky ? " ok" : " fail") + (i === 0 && !reduced ? " fresh" : "")}>
          <div className="pg-path" aria-hidden="true">
            <span>{r.clock}</span><span>{r.data}</span><span>{r.ok ? (r.flaky ? "changed" : "pass") : "bug"}</span>
          </div>
          <p>{r.outcome}</p>
          <p className="muted">{r.note}</p>
        </div>
      ))}
    </div>
  );
}

export default function DependencyInjectionPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<"now" | "jan" | "never" | null>(null);
  const hardRuns = st.hard.count, injRuns = st.inj.count;

  return (
    <PgFrame title="Hunt three bugs in a billing report" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <div className="pg-req">
        <span className="label">Your task</span>
        <h3>Find the three bugs with tests</h3>
        <p>The monthly revenue report goes to the CFO on the first of each month. It has three bugs. Write tests that expose them, on two copies of the same report.</p>
        <table className="di-bugs">
          <thead><tr><th scope="col">Bug</th><th scope="col">Hard-wired</th><th scope="col">Injected</th></tr></thead>
          <tbody>
            {BUGS.map((b) => (
              <tr key={b.id}>
                <td>{st.hard.found.includes(b.id) || st.inj.found.includes(b.id) ? b.title : <span className="muted">Hidden. Hint: {b.how.toLowerCase()}</span>}</td>
                <td className={st.hard.found.includes(b.id) ? "got" : ""}>{st.hard.found.includes(b.id) ? "found" : "·"}</td>
                <td className={st.inj.found.includes(b.id) ? "got" : ""}>{st.inj.found.includes(b.id) ? "found" : "·"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PgPredict
        question="One bug shows only when the report runs in January. Today is 21 November. With the hard-wired report, when can a test first catch it?"
        options={[{ value: "now", label: "Now" }, { value: "jan", label: "On 1 January" }, { value: "never", label: "Never" }]}
        value={guess}
        onChange={setGuess}
        revealed={hardRuns > 0}
        answer="jan"
        explain={<>The report asks the system clock for today, so every test run happens on today&apos;s date. The January case can run on 1 January at the earliest, {DAYS_TO_JANUARY} days from now, and only on the runs that happen that month. The bug ships first. With the clock passed in, January is a value you hand to the test.</>}
      />

      <div className="pg-sides">
        <section className="pg-side" aria-label="Hard-wired report">
          <header><h4>Hard-wired</h4></header>
          <div className="pgc">
            {HARD[lang].map((l, i) => <div key={i} className={"pgc-line" + (i ? " bad" : "")}><code>{l}</code></div>)}
          </div>
          <dl className="di-inputs">
            <div><dt>Clock</dt><dd>the system clock <span className="muted">(a test cannot change it)</span></dd></div>
            <div><dt>Data</dt><dd>shared staging database <span className="muted">(other teams write to it too)</span></dd></div>
          </dl>
          <div className="pg-actions"><PgButton primary onClick={() => dispatch({ type: "runHard" })}>Run the test</PgButton></div>
          <Stats b={st.hard} />
          <Runs runs={st.hard.runs} reduced={reduced} empty="Run it a few times. Watch the date and the data." />
        </section>

        <section className="pg-side" aria-label="Injected report">
          <header><h4>Injected</h4></header>
          <div className="pgc">
            {INJ[lang].map((l, i) => <div key={i} className={"pgc-line" + (i ? "" : " new")}><code>{l}</code></div>)}
          </div>
          <div className="di-pick">
            <span className="label">Clock the test passes in</span>
            <PgChoice<ClockId> label="Clock" value={st.clock} onChange={(c) => dispatch({ type: "clock", clock: c })}
              options={(Object.keys(CLOCKS) as ClockId[]).map((c) => ({ value: c, label: CLOCKS[c].label }))} />
            <span className="label">Invoices the test passes in</span>
            <PgChoice<DataId> label="Data" value={st.data} onChange={(d) => dispatch({ type: "data", data: d })}
              options={(Object.keys(DATA_LABEL) as DataId[]).map((d) => ({ value: d, label: DATA_LABEL[d] }))} />
          </div>
          <div className="pg-actions"><PgButton primary onClick={() => dispatch({ type: "runInj" })}>Run the test</PgButton></div>
          <Stats b={st.inj} />
          <Runs runs={st.inj.runs} reduced={reduced} empty="Pick a date and some data, then run." />
        </section>
      </div>

      {hardRuns > 0 && injRuns > 0 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">Your bug hunt so far</span>
          <p><b>Hard-wired:</b> {n(hardRuns, "run")}, {secs(st.hard.ms)} waiting on the network, {st.hard.found.length} of 3 bugs found{st.hard.flaky ? `, and ${n(st.hard.flaky, "run")} gave a different answer to the same test` : ""}.</p>
          <p><b>Injected:</b> {n(injRuns, "run")}, {secs(st.inj.ms)}, {st.inj.found.length} of 3 bugs found, and the same inputs always gave the same answer.</p>
          <p className="pg-takeaway">
            {st.inj.found.length === 3
              ? "Every bug hid behind an input the hard-wired report chose for itself. Pass the clock and the data in, and each case becomes one argument in a test."
              : "Keep going on the injected bench: each bug needs a different date or a different data source. On the hard-wired bench, you cannot reach any of them."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Martin Fowler: Inversion of Control Containers and the Dependency Injection pattern", href: "https://martinfowler.com/articles/injection.html" },
        { title: "Mark Seemann: Composition Root", href: "https://blog.ploeh.dk/2011/07/28/CompositionRoot/" },
      ]} />

      <style>{`
        .di-bugs { border-collapse: collapse; width: 100%; font-size: .92rem; }
        .di-bugs th, .di-bugs td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
        .di-bugs th { font-family: var(--f-code); font-size: .66rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .di-bugs td.got { color: var(--good); background: var(--good-bg); font-weight: 600; }
        .di-inputs { margin: 0; display: grid; gap: 4px; font-size: .9rem; }
        .di-inputs div { display: grid; grid-template-columns: 4.5em minmax(0, 1fr); gap: 6px; }
        .di-inputs dt { font-family: var(--f-code); font-size: .66rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); padding-top: 3px; }
        .di-inputs dd { margin: 0; }
        .di-pick { display: grid; gap: 4px; justify-items: start; }
        .pg-side .pg-entry .muted { font-size: .85rem; }
      `}</style>
    </PgFrame>
  );
}
