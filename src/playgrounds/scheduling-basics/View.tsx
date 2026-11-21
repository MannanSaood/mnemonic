"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  MAX_ARRIVAL, MAX_JOBS, MAX_RUN, POLICY_NAME, POLICY_NOTE, PRESET_NAME, QUANTA, SWITCH_COSTS,
  allSchedules, init, step, verdict, type Guess, type Job, type Preset, type Schedule,
} from "./model";

const CSS = `
.sb-jobs { width: 100%; border-collapse: collapse; font-size: .85rem; }
.sb-jobs th, .sb-jobs td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
.sb-jobs th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.sb-jobs input { width: 4.5em; font: inherit; font-variant-numeric: tabular-nums; border: 1px solid var(--line); background: var(--bg); color: var(--ink); padding: 1px 4px; }
.sb-kind { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; padding: 1px 4px; border: 1px solid var(--line); }
.sb-kind.interactive { border-color: var(--accent); color: var(--accent); }
.sb-x { border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); font: inherit; padding: 0 6px; cursor: pointer; }
.sb-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sb-sub { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.sb-gantts { display: grid; gap: 8px; }
.sb-g { display: grid; grid-template-columns: minmax(6.5em, 8em) 1fr; gap: 2px 8px; align-items: center; }
.sb-g header { display: grid; }
.sb-g header b { font-family: var(--f-code); font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; }
.sb-g header span { font-size: .72rem; color: var(--ink-2); line-height: 1.2; }
.sb-track { position: relative; height: 26px; border: 1px solid var(--line); background: var(--bg); background-image: linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 10% 100%; overflow: hidden; }
.sb-seg { position: absolute; top: 2px; bottom: 2px; display: flex; align-items: center; justify-content: center; overflow: hidden; font-family: var(--f-code); font-size: .6rem; white-space: nowrap; border-right: 1px solid var(--bg); transition: left .25s var(--ease), width .25s var(--ease); }
.sb-seg.batch { background: var(--surface-2); color: var(--ink); outline: 1px solid var(--ink-2); outline-offset: -1px; }
.sb-seg.interactive { background: var(--accent); color: var(--accent-ink); }
.sb-seg.switch { background: var(--pain); top: 0; bottom: 0; }
.sb-arr { position: absolute; top: 0; height: 5px; border-left: 2px solid var(--ink); }
.sb-axis { grid-column: 2; display: flex; justify-content: space-between; font-family: var(--f-code); font-size: .6rem; color: var(--ink-2); }
.sb-metrics { width: 100%; border-collapse: collapse; font-size: .85rem; }
.sb-metrics th, .sb-metrics td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.sb-metrics th:first-child, .sb-metrics td:first-child { text-align: left; }
.sb-metrics th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.sb-metrics td.best { color: var(--accent); font-weight: 700; }
.sb-metrics td.bad { color: var(--pain); font-weight: 700; }
@media (prefers-reduced-motion: reduce) { .sb-seg { transition: none; } }
`;

const n1 = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

function Gantt({ s, jobs, span }: { s: Schedule; jobs: Job[]; span: number }) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return (
    <div className="sb-g">
      <header><b>{POLICY_NAME[s.policy]}</b><span>{POLICY_NOTE[s.policy]}</span></header>
      <div className="sb-track" role="img" aria-label={`${POLICY_NAME[s.policy]}: ${s.segs.filter((g) => typeof g.job === "number").map((g) => `${byId.get(g.job as number)?.name} ${g.start} to ${g.end} ms`).join(", ")}`}>
        {s.segs.map((g, i) => {
          if (g.job === "idle") return null;
          const j = typeof g.job === "number" ? byId.get(g.job) : null;
          const w = ((g.end - g.start) / span) * 100;
          return (
            <span key={i} className={"sb-seg " + (j ? j.kind : "switch")} style={{ left: `${(g.start / span) * 100}%`, width: `${w}%` }}
              title={j ? `${j.name}: ${g.start}–${g.end} ms` : `context switch ${g.end - g.start} ms`}>
              {j && w > 6 ? j.name : j && w > 2 ? j.name[0] : ""}
            </span>
          );
        })}
        {jobs.map((j) => <span key={j.id} className="sb-arr" style={{ left: `${(j.arrival / span) * 100}%` }} />)}
      </div>
    </div>
  );
}

function Metrics({ scheds }: { scheds: Schedule[] }) {
  const cols: { k: "avgTurnaround" | "avgResponse" | "worstInteractive"; label: string }[] = [
    { k: "avgTurnaround", label: "Avg turnaround" },
    { k: "avgResponse", label: "Avg response" },
    { k: "worstInteractive", label: "Worst interactive wait" },
  ];
  const best = (k: (typeof cols)[number]["k"]) => Math.min(...scheds.map((s) => s[k]));
  const worst = (k: (typeof cols)[number]["k"]) => Math.max(...scheds.map((s) => s[k]));
  return (
    <table className="sb-metrics">
      <caption className="label" style={{ textAlign: "left" }}>Same jobs, four policies (ms)</caption>
      <thead><tr><th>Policy</th>{cols.map((c) => <th key={c.k}>{c.label}</th>)}<th>Switches</th></tr></thead>
      <tbody>
        {scheds.map((s) => (
          <tr key={s.policy}>
            <td>{POLICY_NAME[s.policy]}</td>
            {cols.map((c) => <td key={c.k} className={s[c.k] === best(c.k) ? "best" : s[c.k] === worst(c.k) && best(c.k) !== worst(c.k) ? "bad" : ""}>{n1(s[c.k])}</td>)}
            <td>{s.switches}{s.switchMs ? ` (${s.switchMs} ms)` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ scheds, jobs, quantum, switchCost }: { scheds: Schedule[]; jobs: Job[]; quantum: number; switchCost: number }) {
  const v = verdict(scheds);
  const inter = jobs.filter((j) => j.kind === "interactive").length;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>
        On your {jobs.length} jobs, <b>{POLICY_NAME[v.turnaround.policy]}</b> has the best average turnaround, {n1(v.turnaround.avgTurnaround)} ms against FIFO&apos;s {n1(v.fifo.avgTurnaround)} ms.
        {" "}<b>{POLICY_NAME[v.response.policy]}</b> has the best average response, {n1(v.response.avgResponse)} ms against FIFO&apos;s {n1(v.fifo.avgResponse)} ms.
        {inter > 0 && <> Under FIFO an interactive job waited up to {n1(v.fifo.worstInteractive)} ms before its first instruction; under round robin, {n1(v.rr.worstInteractive)} ms.</>}
        {switchCost > 0 && <> Round robin with a {quantum} ms slice spent {v.rr.switchMs} ms switching.</>}
      </p>
      <p className="pg-takeaway">
        Running the shortest work first wins turnaround, and taking turns wins response. No policy wins both, and the shortest-first ones need run times your scheduler does not know.
      </p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "110", label: "About 110 ms" },
  { value: "80", label: "About 80 ms" },
  { value: "50", label: "About 50 ms" },
];

export default function SchedulingBasicsPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const scheds = allSchedules(st);
  const span = Math.max(20, ...scheds.map((s) => s.makespan));

  return (
    <PgFrame title="Four schedulers, one set of jobs" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        One worker, one CPU. Batch jobs (grey) and interactive jobs (teal) arrive at the times you set and need the CPU for the times you set.
        <b> Turnaround is finish minus arrival. Response is first run minus arrival.</b> Edit the jobs and compare the four schedules.
      </p>

      <PgPredict<Guess>
        question="A 100 ms export arrives a moment before two 10 ms jobs. FIFO runs it first, for an average turnaround of 110 ms. What does shortest-job-first get?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={st.ran}
        answer="50"
        explain="SJF runs the two 10 ms jobs first, finishing at 10 and 20, then the export at 120: (10 + 20 + 120) / 3 = 50. The export finishes no later than under FIFO's 120 ms; the short jobs stop waiting behind it."
      />

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Jobs</span>
          <PgChoice<Preset | "custom"> label="Job set" value={st.preset ?? "custom"}
            options={[...(Object.keys(PRESET_NAME) as Preset[]).map((p) => ({ value: p as Preset | "custom", label: PRESET_NAME[p] })), ...(st.preset ? [] : [{ value: "custom" as const, label: "Yours" }])]}
            onChange={(v) => v !== "custom" && dispatch({ type: "preset", preset: v })} />
          <table className="sb-jobs">
            <thead><tr><th>Job</th><th>Arrives (ms)</th><th>Runs (ms)</th><th /></tr></thead>
            <tbody>
              {st.jobs.map((j) => (
                <tr key={j.id}>
                  <td><span className={"sb-kind " + j.kind}>{j.kind === "batch" ? "batch" : "inter"}</span> {j.name}</td>
                  <td><input type="number" min={0} max={MAX_ARRIVAL} step={5} value={j.arrival} aria-label={`${j.name} arrives at, ms`} onChange={(e) => dispatch({ type: "arrival", id: j.id, value: Number(e.target.value) })} /></td>
                  <td><input type="number" min={1} max={MAX_RUN} step={5} value={j.run} aria-label={`${j.name} runs for, ms`} onChange={(e) => dispatch({ type: "run", id: j.id, value: Number(e.target.value) })} /></td>
                  <td><button className="sb-x" onClick={() => dispatch({ type: "remove", id: j.id })} disabled={st.jobs.length <= 1} aria-label={`Remove ${j.name}`}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sb-row">
            <PgButton onClick={() => dispatch({ type: "add", kind: "batch" })} disabled={st.jobs.length >= MAX_JOBS}>+ batch job</PgButton>
            <PgButton onClick={() => dispatch({ type: "add", kind: "interactive" })} disabled={st.jobs.length >= MAX_JOBS}>+ interactive job</PgButton>
          </div>
        </div>
        <div className="pg-card">
          <span className="label">Round robin</span>
          <span className="sb-sub">Time slice</span>
          <PgChoice<string> label="Round robin time slice" value={String(st.quantum)} options={QUANTA.map((q) => ({ value: String(q), label: `${q} ms` }))} onChange={(v) => dispatch({ type: "quantum", value: Number(v) })} />
          <span className="sb-sub">Cost of each context switch (all policies)</span>
          <PgChoice<string> label="Context switch cost" value={String(st.switchCost)} options={SWITCH_COSTS.map((c) => ({ value: String(c), label: c ? `${c} ms` : "free" }))} onChange={(v) => dispatch({ type: "switchCost", value: Number(v) })} />
          <p className="pg-note">Break it: a 1 ms slice with a 1 ms switch. Then try the Late arrivals set, where SJF and STCF part ways.</p>
          <div className="sb-row"><PgButton primary onClick={() => dispatch({ type: "go" })} disabled={st.ran}>{st.ran ? "Schedules update as you edit" : "Run all four"}</PgButton></div>
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Gantt charts, same time axis</span>
        {!st.ran && <p className="pg-empty">Make your prediction, then press Run all four.</p>}
        {st.ran && (
          <>
            <div className="sb-gantts">
              {scheds.map((s) => <Gantt key={s.policy} s={s} jobs={st.jobs} span={span} />)}
              <div className="sb-g"><span /><div className="sb-axis"><span>0</span><span>{Math.round(span / 2)} ms</span><span>{span} ms</span></div></div>
            </div>
            <span className="sb-sub">Ticks on top mark arrivals. Red slivers are context switches.</span>
            <Metrics scheds={scheds} />
            <Result scheds={scheds} jobs={st.jobs} quantum={st.quantum} switchCost={st.switchCost} />
          </>
        )}
      </div>

      <PgSources links={[
        { title: "OSTEP, Scheduling: Introduction", href: "https://pages.cs.wisc.edu/~remzi/OSTEP/cpu-sched.pdf" },
        { title: "the OSTEP scheduler.py simulator", href: "https://github.com/remzi-arpacidusseau/ostep-homework/tree/master/cpu-sched" },
      ]} />
    </PgFrame>
  );
}
