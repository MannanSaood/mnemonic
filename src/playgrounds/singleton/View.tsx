"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import { TESTS, alwaysFail, flaky, init, step, type ColdMode, type Design, type SuiteRun } from "./model";

const SHORT: Record<string, string> = { eu: "EU VAT", us: "US tax", flag: "new pricing", default: "default price", fake: "refund (fake DB)", report: "daily report" };
const nameOf = (id: string) => TESTS.find((t) => t.id === id)!.name;

const COLD_CODE: Record<Lang, Record<ColdMode, string[]>> = {
  go: {
    naive: ["func Pool() *sql.DB {", "    if pool == nil { pool = openPool() } // two goroutines can both see nil", "    return pool", "}"],
    once: ["var Pool = sync.OnceValue(func() *sql.DB { return openPool() })", "// every caller waits for the first call; openPool runs once"],
  },
  python: {
    naive: ["def get_pool():", "    global _pool", "    if _pool is None:          # two threads can both see None", "        _pool = open_pool()", "    return _pool"],
    once: ["# db.py: module code runs once, under the import lock", "pool = open_pool()"],
  },
  typescript: {
    naive: ["let pool: Pool | undefined;", "export async function getPool() {", "  if (!pool) pool = await createPool(); // two requests can both await", "  return pool;", "}"],
    once: ["let poolPromise: Promise<Pool> | undefined;", "export const getPool = () => (poolPromise ??= createPool()); // store the promise"],
  },
  rust: {
    naive: ["// Rust will not compile an unsynchronised global you can mutate.", "// static mut POOL: Option<Pool> = None;  ← needs unsafe on every access"],
    once: ["static POOL: LazyLock<Pool> = LazyLock::new(|| Pool::open());", "// or OnceLock::get_or_init when the config arrives at runtime"],
  },
};

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Gantt({ run }: { run: SuiteRun }) {
  const end = Math.max(...run.slots.map((s) => s.end));
  return (
    <div className="sg-gantt" style={{ gridTemplateColumns: `4.2em repeat(${end}, minmax(0, 1fr))` }} role="group" aria-label="When each test ran">
      {Array.from({ length: run.workers }, (_, w) => (
        <div key={w} className="sg-row">
          <span className="label" style={{ gridColumn: 1, gridRow: w + 1 }}>worker {w + 1}</span>
        </div>
      ))}
      {run.slots.map((s) => (
        <div key={s.test} className={"sg-bar " + (s.ok ? "ok" : "fail")}
          style={{ gridRow: s.worker + 1, gridColumn: `${s.start + 2} / ${s.end + 2}` }}
          title={`${nameOf(s.test)}: ${s.ok ? "passed" : s.why}`}>
          <span>{s.ok ? "✓" : "✗"} {SHORT[s.test]}</span>
        </div>
      ))}
    </div>
  );
}

export default function SingletonPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const r = st.last;
  const fl = flaky(st.history), always = alwaysFail(st.history);
  const failedEver = new Set(st.history.flatMap((h) => h.failed));

  return (
    <PgFrame title="Run the suite against one global config" onReset={() => dispatch({ type: "reset" })}>
      <div className="pg-req">
        <span className="label">The suite</span>
        <p>Six tests for a pricing service. Each one passes when you run it alone. They all read settings from <code>Config</code>: the region, a pricing flag, and which database pool to use. Some tests change a setting first.</p>
      </div>

      <div className="sg-controls">
        <PgChoice<Design> label="Design" value={st.design} onChange={(d) => dispatch({ type: "design", design: d })}
          options={[{ value: "global", label: "Global singleton" }, { value: "injected", label: "Config passed in" }]} />
        <PgChoice<string> label="Parallel workers" value={String(st.workers)} onChange={(v) => dispatch({ type: "workers", n: Number(v) })}
          options={["1", "2", "3", "4"].map((v) => ({ value: v, label: `${v} worker${v === "1" ? "" : "s"}` }))} />
        <button className="pg-btn" aria-pressed={st.teardown} onClick={() => dispatch({ type: "teardown" })} disabled={st.design === "injected"}>
          {st.teardown ? "☑" : "☐"} Reset the global in teardown
        </button>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <PgPredict<"none" | "some" | "all">
            question="Each test passes alone. Run the whole suite once, on one worker. What happens?"
            options={[{ value: "none", label: "All pass" }, { value: "some", label: "Some fail, depending on order" }, { value: "all", label: "All fail" }]}
            value={st.prediction}
            onChange={(v) => dispatch({ type: "predict", value: v })}
            revealed={st.history.length > 0}
            answer="some"
            explain="A test that sets the pricing flag leaves it set. Whichever test runs after it and expects the default fails, and it fails because of a test it never mentions. Change the order and a different test fails."
          />
          <div className="pg-actions">
            <PgButton primary onClick={() => dispatch({ type: "run" })}>Run the suite</PgButton>
            <PgButton onClick={() => dispatch({ type: "runMany", times: 10 })}>Run it 10 times</PgButton>
          </div>
        </div>

        <div className="pg-card">
          <span className="label">{st.design === "global" ? "Config.instance · one object, every test" : "new Config(...) · one per test"}</span>
          {st.design === "global" ? (
            <ul className="sg-who">
              {TESTS.map((t) => (
                <li key={t.id} className={failedEver.has(t.id) ? "bad" : ""}>
                  <b>{SHORT[t.id]}</b> {Object.keys(t.writes).length ? <>writes <code>{Object.entries(t.writes).map(([k, v]) => `${k}=${v}`).join(", ")}</code></> : "only reads"}, expects <code>{Object.entries(t.expect).map(([k, v]) => `${k}=${v}`).join(", ")}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Each test builds the Config it needs and passes it to the pricing service. No test can see another&apos;s settings, so order and parallelism stop mattering.</p>
          )}
        </div>
      </div>

      <div className="pg-card">
        <span className="label">{r ? `Last run · order seed ${r.seed} · ${n(r.workers, "worker")}${r.design === "global" ? (r.teardown ? " · teardown on" : " · no teardown") : " · injected"}` : "No run yet"}</span>
        {r ? <div className={reduced ? "" : "sg-fresh"} key={r.seed}><Gantt run={r} /></div> : <p className="pg-empty">Press Run the suite.</p>}
        {r && r.failed.length > 0 && (
          <div className="pg-log" aria-live="polite">
            {r.slots.filter((s) => !s.ok).map((s) => (
              <div key={s.test} className="pg-entry fail">
                <div className="pg-path" aria-hidden="true"><span>{SHORT[s.test]}</span><span>Config</span>{s.blame && <span>set by {SHORT[s.blame]}</span>}</div>
                <p>&ldquo;{nameOf(s.test)}&rdquo; {s.why}{s.blame ? `, left there by “${nameOf(s.blame)}”, a test it never mentions.` : "."}</p>
              </div>
            ))}
          </div>
        )}
        <dl className="pg-stats">
          <div><dt>Runs (these settings)</dt><dd>{st.history.length}</dd></div>
          <div className={r?.failed.length ? "bad" : ""}><dt>Failed last run</dt><dd>{r ? r.failed.length : "-"}</dd></div>
          <div className={fl.length ? "bad" : ""}><dt>Flaky tests</dt><dd>{fl.length}</dd></div>
          <div className={always.length ? "bad" : ""}><dt>Always fail</dt><dd>{always.length}</dd></div>
        </dl>
        {st.history.length > 1 && (
          <p className="pg-takeaway" aria-live="polite">
            {st.design === "injected"
              ? `${n(st.history.length, "run")} with ${n(st.workers, "worker")}, in different orders: no failures. Every test owns its Config, so there is nothing to share and nothing to reset.`
              : fl.length
                ? `${n(st.history.length, "run")} with these settings: ${n(fl.length, "test")} (${fl.map((x) => SHORT[x]).join(", ")}) passed in some runs and failed in others. None of them has a bug.${st.teardown ? " Teardown fixed the order problem, but with parallel workers two tests share the global at the same time." : ""}`
                : `${n(st.history.length, "run")} with these settings and no failures.${st.workers === 1 && st.teardown ? " Teardown works, on one worker. Now add a second worker." : ""}`}
          </p>
        )}
      </div>

      <div className="pg-card">
        <span className="label">When one instance really is right · a connection pool at cold start</span>
        <p className="muted">Three requests arrive together before the pool exists. Each one checks whether a pool exists and creates one if not. Opening a pool takes a moment.</p>
        <PgChoice<ColdMode> label="Initialisation" value={st.coldMode} onChange={(m) => dispatch({ type: "coldMode", mode: m })}
          options={[{ value: "naive", label: "Check, then create" }, { value: "once", label: "Once-guard" }]} />
        <div className="pgc">{COLD_CODE[lang][st.coldMode].map((l, i) => <div key={i} className="pgc-line"><code>{l}</code></div>)}</div>
        <div className="pg-actions"><PgButton onClick={() => dispatch({ type: "coldStart" })}>Cold start: 3 requests at once</PgButton></div>
        {st.cold && (
          <div className={"pg-entry " + (st.cold.pools === 1 ? "ok" : "fail")} aria-live="polite">
            <div className="pg-path" aria-hidden="true">
              {st.cold.checks.map((c, i) => <span key={i}>req {i + 1} checks at t{c}</span>)}
            </div>
            <p>{st.cold.mode === "once"
              ? "One pool, 20 connections. The first request opens it; the others wait for it and reuse it."
              : `${n(st.cold.pools, "pool")}, ${st.cold.pools * 20} connections to the database. ${st.cold.pools > 1 ? "Every request that checked before the first pool was ready made its own, and only the last one is kept: the others leak." : "This time the timing happened to work. Press again."}`}</p>
          </div>
        )}
      </div>

      <PgSources links={[
        { title: "Miško Hevery: Singletons are Pathological Liars", href: "https://testing.googleblog.com/2008/08/by-miko-hevery-so-you-join-new-project.html" },
        { title: "Chromium: fixing flaky unit tests", href: "https://www.chromium.org/developers/testing/fixing-flaky-tests/fixing_flaky_unittests/" },
        { title: "Rust std::sync::OnceLock", href: "https://doc.rust-lang.org/std/sync/struct.OnceLock.html" },
      ]} />

      <style>{`
        .sg-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        .sg-controls .pg-btn[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
        .sg-who { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: .9rem; }
        .sg-who li { border-left: 3px solid var(--line); padding-left: 8px; }
        .sg-who li.bad { border-left-color: var(--pain); }
        .sg-who code { font-size: .7rem; }
        .sg-gantt { display: grid; gap: 3px; align-items: stretch; }
        .sg-row { display: contents; }
        .sg-row .label { align-self: center; }
        .sg-bar { border: 1px solid var(--good); background: var(--good-bg); color: var(--good); padding: 3px 4px; min-height: 30px; overflow: hidden; font-family: var(--f-code); font-size: .62rem; display: flex; align-items: center; }
        .sg-bar.fail { border-color: var(--pain); background: var(--pain-bg); color: var(--pain); font-weight: 600; }
        .sg-bar span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sg-fresh .sg-bar { animation: pg-hop .3s var(--ease) both; }
        @media (prefers-reduced-motion: reduce) { .sg-fresh .sg-bar { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
