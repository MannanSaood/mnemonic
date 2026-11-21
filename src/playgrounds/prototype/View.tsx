"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import { MODES, REGIONS, SCENARIO, hostOf, init, referrers, shared, step, type Mode, type Region, type State } from "./model";

const MODE_LABEL: Record<Mode, string> = { assign: "No copy", shallow: "Shallow copy", deep: "Deep copy", clone: "Its own clone()" };
const MODE_CODE: Record<Lang, Record<Mode, string>> = {
  go: {
    assign: "job := tmpl            // *JobConfig: the same object",
    shallow: "job := *tmpl           // copies the struct; the Env map is shared",
    deep: "job := deepCopy(tmpl)  // copies everything, the HTTP pool too",
    clone: "job := tmpl.Clone()    // copies Env, shares the pool",
  },
  python: {
    assign: "job = tmpl",
    shallow: "job = copy.copy(tmpl)      # new object, same env dict",
    deep: "job = copy.deepcopy(tmpl)  # copies everything, the HTTP pool too",
    clone: "job = tmpl.clone()         # copies env, shares the pool",
  },
  typescript: {
    assign: "const job = tmpl;",
    shallow: "const job = { ...tmpl };   // new object, same env object",
    deep: "const job = deepCopy(tmpl); // copies everything, the HTTP pool too",
    clone: "const job = tmpl.clone();  // copies env, shares the pool",
  },
  rust: {
    assign: "let job = Rc::clone(&tmpl);  // the same object",
    shallow: "let job = tmpl.clone();  // env: Rc<RefCell<HashMap>> is shared",
    deep: "let job = deep_clone(&tmpl); // copies everything, the HTTP pool too",
    clone: "let job = tmpl.clone();  // env: HashMap copied, client: Arc shared",
  },
};
const NAME: Record<string, string> = { template: "template", us: "us_job", eu: "eu_job" };

/* ---------------- the heap diagram ---------------- */

const ROW = 84, TOP = 14;
function Heap({ st, reduced }: { st: State; reduced: boolean }) {
  const jobIds = Object.keys(st.jobs).map(Number).sort((a, b) => a - b);
  const jobRow = (id: number) => jobIds.indexOf(id);
  const envRow = (id: number) => jobRow(jobIds.find((j) => st.jobs[j].env === id)!);
  const clientRow = (id: number) => jobRow(jobIds.find((j) => st.jobs[j].client === id)!);
  const envIds = [...new Set(jobIds.map((j) => st.jobs[j].env))];
  const y = (r: number) => TOP + r * ROW;
  const touchedEnv = st.touched?.env, touchedJob = st.touched?.job;
  const reach = touchedEnv !== undefined ? referrers(st, { env: touchedEnv }) : touchedJob !== undefined ? referrers(st, { job: touchedJob }) : [];
  const h = TOP + Math.max(jobIds.length, st.vars.length) * ROW + 6;
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
  return (
    <svg className={"pt-heap" + (reduced ? "" : " anim")} viewBox={`0 0 560 ${h}`} role="img"
      aria-label={`Heap: ${st.vars.map((v) => `${NAME[v.name]} points at job ${v.job}`).join(", ")}. ${shared(st).envs} env maps shared.`}>
      <defs>
        <marker id="pt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker>
      </defs>
      <text x="8" y="10" className="pt-col">variables</text>
      <text x="130" y="10" className="pt-col">job objects</text>
      <text x="330" y="10" className="pt-col">env maps</text>
      <text x="482" y="10" className="pt-col">http pools</text>
      {/* arrows first, boxes on top */}
      {st.vars.map((v, i) => (
        <path key={"v" + v.name} className={"pt-ref" + (st.surprised.includes(v.name) ? " bad" : "")} d={curve(86, y(i) + 32, 130, y(jobRow(v.job)) + 20)} markerEnd="url(#pt-arrow)" />
      ))}
      {jobIds.map((j) => {
        const jb = st.jobs[j], r = jobRow(j);
        return (
          <g key={"a" + j}>
            <path className={"pt-ref" + (jb.env === touchedEnv ? " hot" : "")} d={curve(272, y(r) + 46, 330, y(envRow(jb.env)) + 25)} markerEnd="url(#pt-arrow)" />
            <path className="pt-ref soft" d={curve(272, y(r) + 62, 482, y(clientRow(jb.client)) + 17)} markerEnd="url(#pt-arrow)" />
          </g>
        );
      })}
      {st.vars.map((v, i) => (
        <g key={v.name}>
          <rect x="8" y={y(i) + 17} width="78" height="30" className={"pt-box var" + (st.surprised.includes(v.name) ? " bad" : reach.includes(v.name) ? " hot" : "")} />
          <text x="47" y={y(i) + 36} textAnchor="middle" className="pt-t">{NAME[v.name]}</text>
        </g>
      ))}
      {jobIds.map((j) => {
        const jb = st.jobs[j], r = jobRow(j);
        return (
          <g key={j}>
            <rect x="130" y={y(r)} width="150" height="72" className={"pt-box" + (j === touchedJob ? " hot" : "")} />
            <text x="138" y={y(r) + 15} className="pt-t b">Job #{j}</text>
            <text x="138" y={y(r) + 31} className="pt-t">retries: {jb.retries}</text>
            <text x="138" y={y(r) + 50} className="pt-t">env</text>
            <text x="138" y={y(r) + 66} className="pt-t">client</text>
            <circle cx="272" cy={y(r) + 46} r="3.5" className="pt-dot" />
            <circle cx="272" cy={y(r) + 62} r="3.5" className="pt-dot" />
          </g>
        );
      })}
      {envIds.map((e) => (
        <g key={"e" + e}>
          <rect x="330" y={y(envRow(e))} width="140" height="50" className={"pt-box map" + (e === touchedEnv ? " hot" : "")} />
          <text x="336" y={y(envRow(e)) + 15} className="pt-t b">DB_HOST</text>
          <text x="336" y={y(envRow(e)) + 31} className="pt-t">{st.envs[e].DB_HOST}</text>
          <text x="336" y={y(envRow(e)) + 45} className="pt-t dim">LOG_LEVEL info</text>
        </g>
      ))}
      {st.clients.map((c) => (
        <g key={"c" + c}>
          <rect x="482" y={y(clientRow(c))} width="72" height="34" className="pt-box pool" />
          <text x="518" y={y(clientRow(c)) + 21} textAnchor="middle" className="pt-t">pool #{c}</text>
        </g>
      ))}
    </svg>
  );
}

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

export default function PrototypePlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const has = (r: Region) => st.vars.some((v) => v.name === r);
  const sh = shared(st);
  const playScenario = () => { dispatch({ type: "mode", mode: st.mode }); SCENARIO.forEach((a) => dispatch(a)); };

  return (
    <PgFrame title="Clone a job template for two regions" onReset={() => dispatch({ type: "reset" })}>
      <div className="pg-req">
        <span className="label">The task</span>
        <p>The nightly billing job is configured once, as a template. Make a US copy and an EU copy, point each at its own region&apos;s database, and run them. EU customer data must stay in the EU database.</p>
      </div>

      <div className="pg-card">
        <span className="label">How a copy is made</span>
        <PgChoice<Mode> label="Copy method" value={st.mode} onChange={(m) => dispatch({ type: "mode", mode: m })}
          options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        <div className="pgc"><div className="pgc-line"><code>{MODE_CODE[lang][st.mode]}</code></div></div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Act</span>
          {REGIONS.map((r) => (
            <div key={r} className="pt-row">
              <b>{r.toUpperCase()}</b>
              {!has(r)
                ? <PgButton onClick={() => dispatch({ type: "clone", region: r })}>Copy template → {NAME[r]}</PgButton>
                : (
                  <>
                    <PgButton onClick={() => dispatch({ type: "setHost", region: r })}>Set DB_HOST = {r}-db</PgButton>
                    <PgButton onClick={() => dispatch({ type: "setRetries", region: r })}>Set retries = 5</PgButton>
                  </>
                )}
            </div>
          ))}
          <div className="pg-actions">
            <PgButton primary onClick={() => dispatch({ type: "run" })}>Run all jobs</PgButton>
            <PgButton onClick={playScenario}>Play the whole scenario</PgButton>
          </div>
          {st.surprised.length > 0 && (
            <p className="pt-warn" aria-live="polite">You edited one job, and {st.surprised.map((x) => NAME[x]).join(" and ")} changed too. Follow the arrows: they reach the same {st.touched?.env !== undefined ? "env map" : "job object"}.</p>
          )}
        </div>

        <div className="pg-card">
          <PgPredict<"us-db" | "eu-db" | "template-db">
            question="With a shallow copy: copy for US and set its DB_HOST, then copy for EU and set its DB_HOST. Where does the US job write?"
            options={[{ value: "us-db", label: "us-db" }, { value: "eu-db", label: "eu-db" }, { value: "template-db", label: "staging-db" }]}
            value={st.prediction}
            onChange={(v) => dispatch({ type: "predict", value: v })}
            revealed={st.runs.length > 0}
            answer="eu-db"
            explain="A shallow copy makes a new job object, but its env field still points at the template's map. Setting US's DB_HOST changed the template's map, the EU copy then shared that same map, and the last write, eu-db, is what all three jobs read."
          />
        </div>
      </div>

      <div className="pg-card">
        <span className="label">The heap</span>
        <Heap st={st} reduced={reduced} />
        <dl className="pg-stats">
          <div><dt>Job objects</dt><dd>{Object.keys(st.jobs).length}</dd></div>
          <div className={sh.envs || sh.jobs ? "bad" : ""}><dt>Shared env maps</dt><dd>{sh.envs}</dd></div>
          <div className={st.clients.length > 1 ? "bad" : ""}><dt>HTTP pools</dt><dd>{st.clients.length}</dd></div>
          <div><dt>US job DB</dt><dd>{hostOf(st, "us")?.split(".")[0] ?? "-"}</dd></div>
        </dl>
        {st.ran && (
          <div className="pg-log" aria-live="polite">
            {st.ran.map((r) => (
              <div key={r.name} className={"pg-entry " + (r.ok ? "ok" : "fail")}>
                <div className="pg-path" aria-hidden="true"><span>{NAME[r.name]}</span><span>{r.host}</span><span>{r.ok ? "✓" : "✗"}</span></div>
                <p>{r.ok ? `Writes to ${r.host}, as intended.` : `Should write to ${r.expected}, but writes to ${r.host}.${r.name === "us" && r.host.startsWith("eu") ? " US billing data lands in the EU database." : r.name === "template" ? " The template itself was changed." : ""}`}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {st.runs.length > 0 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your runs showed</span>
          <div className="pt-scroll">
            <table className="pt-table">
              <thead><tr><th>Copy method</th><th>Jobs on the wrong DB</th><th>HTTP pools</th></tr></thead>
              <tbody>
                {st.runs.map((r) => (
                  <tr key={r.mode}><th scope="row">{MODE_LABEL[r.mode]}</th><td className={r.wrong ? "bad" : ""}>{r.wrong}</td><td className={r.pools > 1 ? "bad" : ""}>{r.pools}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pg-takeaway">
            {st.runs.some((r) => r.mode === "clone" && r.wrong === 0 && r.pools === 1)
              ? "Only the job's own clone() got both right: it copies the data each copy will change, and shares the service every copy should use. That decision belongs to the object, which is what Prototype asks of it."
              : st.runs.some((r) => r.mode === "deep" && r.wrong === 0)
                ? `Deep copy fixed the databases but left you with ${n(Math.max(...st.runs.filter((r) => r.mode === "deep").map((r) => r.pools)), "HTTP pool")}: it copied what should have been shared. Try the job's own clone().`
                : "A copy that shares nested data lets one edit leak into every copy. Try a deep copy, then the job's own clone()."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Python Tutor's heap diagrams", href: "https://pythontutor.com/" },
        { title: "Python docs: shallow and deep copy operations", href: "https://docs.python.org/3/library/copy.html" },
        { title: "Refactoring.Guru: Prototype", href: "https://refactoring.guru/design-patterns/prototype" },
      ]} />

      <style>{`
        .pt-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .pt-row b { font-family: var(--f-code); font-size: .75rem; width: 2.4em; }
        .pt-warn { margin: 0; color: var(--pain); font-size: .95rem; }
        .pt-heap { width: 100%; height: auto; color: var(--ink-2); background: var(--surface); border: 1px solid var(--line); }
        .pt-col { font-family: var(--f-code); font-size: 8px; letter-spacing: .08em; text-transform: uppercase; fill: var(--ink-2); }
        .pt-box { fill: var(--bg); stroke: var(--line); stroke-width: 1; transition: fill .25s var(--ease), stroke .25s var(--ease); }
        .pt-box.map { stroke: var(--accent); stroke-dasharray: 4 3; }
        .pt-box.pool { fill: var(--surface-2); }
        .pt-box.hot { fill: var(--hl); stroke: var(--accent); stroke-width: 2; }
        .pt-box.bad { fill: var(--pain-bg); stroke: var(--pain); stroke-width: 2; }
        .pt-t { font-family: var(--f-code); font-size: 10px; fill: var(--ink); }
        .pt-t.b { font-weight: 700; }
        .pt-t.dim { fill: var(--ink-2); }
        .pt-dot { fill: var(--ink); }
        .pt-ref { fill: none; stroke: currentColor; stroke-width: 1.3; }
        .pt-ref.soft { stroke-dasharray: 3 3; opacity: .6; }
        .pt-ref.hot { stroke: var(--accent); stroke-width: 2.2; color: var(--accent); }
        .pt-ref.bad { stroke: var(--pain); color: var(--pain); stroke-width: 2.2; }
        .pt-heap.anim .pt-ref { transition: d .3s var(--ease); }
        .pt-scroll { overflow-x: auto; }
        .pt-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
        .pt-table th, .pt-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
        .pt-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .pt-table td.bad { color: var(--pain); font-weight: 600; }
        @media (prefers-reduced-motion: reduce) { .pt-box, .pt-heap .pt-ref { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
