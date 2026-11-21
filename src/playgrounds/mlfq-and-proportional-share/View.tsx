"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BOOSTS, KIND_NAME, LEVELS, MAX_JOBS, POLICIES, POLICY_NAME, SHORT_WINDOW, SLICES, TICKETS, WINDOW,
  allRuns, allotment, init, shareError, step, ticketShare,
  type Guess, type Job, type Kind, type Policy, type RunResult, type State,
} from "./model";

const CSS = `
.mq-jobs { display: grid; gap: 4px; }
.mq-job { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border: 1px solid var(--line); background: var(--surface); padding: 4px 6px; }
.mq-job b { font-family: var(--f-code); font-size: .75rem; min-width: 5em; }
.mq-kind { font-family: var(--f-code); font-size: .58rem; text-transform: uppercase; letter-spacing: .06em; padding: 1px 4px; border: 1px solid var(--line); color: var(--ink-2); }
.mq-kind.interactive { border-color: var(--accent); color: var(--accent); }
.mq-kind.gamer { border-color: var(--pain); color: var(--pain); }
.mq-x { margin-left: auto; border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); font: inherit; padding: 0 6px; cursor: pointer; }
.mq-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.mq-sub { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.mq-lanes { display: grid; gap: 4px; }
.mq-lane { display: grid; grid-template-columns: minmax(5.5em, 7em) 1fr; gap: 8px; align-items: center; }
.mq-lane > span { font-family: var(--f-code); font-size: .7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mq-track { position: relative; height: 22px; border: 1px solid var(--line); background: var(--bg); background-image: linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 12.5% 100%; overflow: hidden; }
.mq-track i { position: absolute; display: block; }
.mq-run { top: 2px; bottom: 2px; background: var(--accent); }
.mq-wait { top: 9px; height: 4px; background: var(--pain); opacity: .8; }
.mq-block { top: 9px; height: 4px; background: repeating-linear-gradient(90deg, var(--ink-2), var(--ink-2) 1px, transparent 1px, transparent 3px); opacity: .5; }
.mq-boost { top: 0; bottom: 0; width: 0; border-left: 1px dashed var(--ink); }
.mq-axis { display: flex; justify-content: space-between; font-family: var(--f-code); font-size: .6rem; color: var(--ink-2); grid-column: 2; }
.mq-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.mq-legend i { display: inline-block; width: 12px; height: 8px; margin-right: 4px; vertical-align: 0; }
.mq-cmp { width: 100%; border-collapse: collapse; font-size: .82rem; }
.mq-cmp th, .mq-cmp td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.mq-cmp th:first-child, .mq-cmp td:first-child { text-align: left; }
.mq-cmp th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.mq-cmp td.bad { color: var(--pain); font-weight: 700; }
.mq-cmp td.sel { background: var(--hl); }
`;

const LEVEL_OPACITY = [1, 0.62, 0.38, 0.22];
const pct = (x: number) => `${Math.round(x * 100)}%`;

function Lanes({ run, jobs }: { run: RunResult; jobs: Job[] }) {
  return (
    <div className="mq-lanes">
      {run.jobs.map((r) => {
        const j = jobs.find((x) => x.id === r.id)!;
        return (
          <div key={r.id} className="mq-lane">
            <span title={`${j.name}, ${KIND_NAME[j.kind]}`}>{j.name}</span>
            <div className="mq-track" role="img" aria-label={`${j.name}: ran ${pct(r.share)} of the time, longest wait ${r.worstWait} ms${run.policy === "mlfq" ? `, ends at level ${r.finalLevel}` : ""}`}>
              {r.segs.map((g, i) => (
                <i key={i} className={`mq-${g.state}`} style={{ left: `${(g.start / WINDOW) * 100}%`, width: `${((g.end - g.start) / WINDOW) * 100}%`, opacity: g.state === "run" ? LEVEL_OPACITY[g.level] : undefined }}
                  title={g.state === "run" && run.policy === "mlfq" ? `level ${g.level}, ${g.start}–${g.end} ms` : `${g.state} ${g.start}–${g.end} ms`} />
              ))}
              {run.boosts.map((b) => <i key={`b${b}`} className="mq-boost" style={{ left: `${(b / WINDOW) * 100}%` }} />)}
            </div>
          </div>
        );
      })}
      <div className="mq-lane"><span /><div className="mq-axis"><span>0</span><span>{WINDOW / 2} ms</span><span>{WINDOW} ms</span></div></div>
    </div>
  );
}

function Compare({ runs, jobs, policy }: { runs: RunResult[]; jobs: Job[]; policy: Policy }) {
  return (
    <table className="mq-cmp">
      <caption className="label" style={{ textAlign: "left" }}>Same jobs, three schedulers: CPU share · longest wait</caption>
      <thead><tr><th>Job</th><th>Tickets</th>{runs.map((r) => <th key={r.policy}>{POLICY_NAME[r.policy]}</th>)}</tr></thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id}>
            <td>{j.name} <span className="mq-sub">{KIND_NAME[j.kind]}</span></td>
            <td>{j.tickets} ({pct(ticketShare(jobs, j.id))})</td>
            {runs.map((r) => {
              const x = r.jobs.find((y) => y.id === j.id)!;
              const starved = x.worstWait >= 100;
              return <td key={r.policy} className={(r.policy === policy ? "sel " : "") + (starved || (j.kind === "gamer" && x.share > 0.7) ? "bad" : "")}>{pct(x.share)} · {x.worstWait} ms</td>;
            })}
          </tr>
        ))}
        <tr>
          <td colSpan={2}>Worst gap from ticket share, first {SHORT_WINDOW} ms</td>
          {runs.map((r) => <td key={r.policy} className={r.policy === policy ? "sel" : ""}>{pct(shareError(r, jobs, true))}</td>)}
        </tr>
      </tbody>
    </table>
  );
}

function Result({ st, runs }: { st: State; runs: RunResult[] }) {
  const mlfq = runs[0], stride = runs[2], lottery = runs[1];
  const gamer = st.jobs.find((j) => j.kind === "gamer");
  const cpu = st.jobs.find((j) => j.kind === "cpu");
  const g = gamer && mlfq.jobs.find((x) => x.id === gamer.id)!;
  const c = cpu && mlfq.jobs.find((x) => x.id === cpu.id)!;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>
        Under your MLFQ ({st.cfg.levels} levels, top allotment {st.cfg.slice} ms, {st.cfg.boost ? `boost every ${st.cfg.boost} ms` : "no boost"}, accounting {st.cfg.accounting ? "on" : "off"}):
        {g && <> the gamer took <b>{pct(g.share)}</b> of the CPU.</>}
        {c && <> {cpu!.name} ran {pct(c.share)} and waited up to <b>{c.worstWait} ms</b> at a stretch.</>}
        {" "}Stride kept every CPU-hungry job within {pct(shareError(stride, st.jobs))} of its ticket share; lottery was off by up to {pct(shareError(lottery, st.jobs, true))} over the first {SHORT_WINDOW} ms.
      </p>
      <p className="pg-takeaway">
        MLFQ guesses who is interactive from behaviour, so behaviour can fool it: accounting stops the gaming and the boost stops starvation. Proportional share does not guess. It gives each job its tickets&apos; worth, whatever the job does.
      </p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "half", label: "About half" },
  { value: "most", label: "Most of it, ~90%" },
  { value: "all", label: "All of it" },
];

export default function MlfqPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const runs = allRuns(st);
  const run = runs[POLICIES.indexOf(st.policy)];
  const full = st.jobs.length >= MAX_JOBS;

  return (
    <PgFrame title="Tune it, game it, compare it" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        One CPU, {WINDOW} ms. <b>MLFQ runs the highest level first and moves a job down when it uses up its allotment at a level.</b> A job that gives up the CPU early stays up.
        Add a gamer, a job that runs one ms short of the top-level allotment and then does a 1 ms I/O, and see who gets the CPU. Then compare with lottery and stride on the same jobs.
      </p>

      <PgPredict<Guess>
        question={`A CPU-bound batch job shares the MLFQ with a gamer that runs ${st.cfg.slice - 1} ms of every ${st.cfg.slice} ms allotment, then does a 1 ms I/O. Accounting is off, no boost. What share of the CPU does the gamer get?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={st.sawGaming}
        answer="most"
        explain="It never uses a whole allotment, so it never moves down, and it outranks the batch job, which sank after its first allotment. The batch job only runs during the gamer's 1 ms of I/O. Turn accounting on and the gamer sinks too."
      />

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Jobs</span>
          <div className="mq-jobs">
            {st.jobs.map((j) => (
              <div key={j.id} className="mq-job">
                <b>{j.name}</b><span className={"mq-kind " + j.kind}>{KIND_NAME[j.kind]}</span>
                <PgChoice<string> label={`${j.name} tickets`} value={String(j.tickets)} options={TICKETS.map((t) => ({ value: String(t), label: String(t), note: `${t} tickets` }))} onChange={(v) => dispatch({ type: "tickets", id: j.id, tickets: Number(v) })} />
                <button className="mq-x" onClick={() => dispatch({ type: "remove", id: j.id })} disabled={st.jobs.length <= 1} aria-label={`Remove ${j.name}`}>×</button>
              </div>
            ))}
          </div>
          <div className="mq-row">
            {(["cpu", "interactive", "gamer"] as Kind[]).map((k) => <PgButton key={k} onClick={() => dispatch({ type: "add", kind: k })} disabled={full}>+ {KIND_NAME[k]}</PgButton>)}
          </div>
          <span className="mq-sub">Tickets matter to lottery and stride only</span>
        </div>
        <div className="pg-card">
          <span className="label">MLFQ rules</span>
          <span className="mq-sub">Levels</span>
          <PgChoice<string> label="Levels" value={String(st.cfg.levels)} options={LEVELS.map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => dispatch({ type: "levels", value: Number(v) })} />
          <span className="mq-sub">Top-level allotment (doubles per level: {Array.from({ length: st.cfg.levels }, (_, k) => allotment(st.cfg, k)).join(", ")} ms)</span>
          <PgChoice<string> label="Top-level allotment" value={String(st.cfg.slice)} options={SLICES.map((n) => ({ value: String(n), label: `${n} ms` }))} onChange={(v) => dispatch({ type: "slice", value: Number(v) })} />
          <span className="mq-sub">Priority boost (Rule 5)</span>
          <PgChoice<string> label="Priority boost" value={String(st.cfg.boost)} options={BOOSTS.map((n) => ({ value: String(n), label: n ? `every ${n} ms` : "off" }))} onChange={(v) => dispatch({ type: "boost", value: Number(v) })} />
          <span className="mq-sub">Accounting (Rule 4)</span>
          <PgChoice<"off" | "on"> label="Accounting" value={st.cfg.accounting ? "on" : "off"}
            options={[{ value: "off", label: "Off: blocking resets it" }, { value: "on", label: "On: time adds up" }]}
            onChange={(v) => dispatch({ type: "accounting", value: v === "on" })} />
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Timeline</span>
        <div className="mq-row">
          <PgChoice<Policy> label="Scheduler shown" value={st.policy} options={POLICIES.map((p) => ({ value: p, label: POLICY_NAME[p] }))} onChange={(p) => dispatch({ type: "policy", policy: p })} />
          {st.policy === "lottery" && <PgButton onClick={() => dispatch({ type: "reroll" })}>Draw again</PgButton>}
          {!st.ran && <PgButton primary onClick={() => dispatch({ type: "run" })}>Run {WINDOW} ms</PgButton>}
        </div>
        <div className="mq-legend">
          {st.policy === "mlfq" ? LEVEL_OPACITY.slice(0, st.cfg.levels).map((o, k) => <span key={k}><i style={{ background: "var(--accent)", opacity: o }} />runs at level {k}</span>) : <span><i style={{ background: "var(--accent)" }} />runs</span>}
          <span><i className="mq-wait" style={{ position: "static", display: "inline-block" }} />ready, waiting</span>
          <span><i className="mq-block" style={{ position: "static", display: "inline-block" }} />blocked on I/O</span>
          {st.policy === "mlfq" && st.cfg.boost > 0 && <span><i style={{ borderLeft: "1px dashed var(--ink)", width: 0 }} />boost</span>}
        </div>
        {!st.ran && <p className="pg-empty">Make your prediction, add a gamer, then run.</p>}
        {st.ran && (
          <>
            <Lanes run={run} jobs={st.jobs} />
            <Compare runs={runs} jobs={st.jobs} policy={st.policy} />
            <Result st={st} runs={runs} />
          </>
        )}
        <p className="pg-note">Challenges: make the batch job starve (two gamers, no boost). Then stop it with the boost alone, and stop the gaming with accounting alone. Then give batch 200 tickets and the gamer 50, and compare stride with MLFQ.</p>
      </div>

      <PgSources links={[
        { title: "OSTEP, Multi-level Feedback Queue", href: "https://pages.cs.wisc.edu/~remzi/OSTEP/cpu-sched-mlfq.pdf" },
        { title: "OSTEP, Lottery Scheduling", href: "https://pages.cs.wisc.edu/~remzi/OSTEP/cpu-sched-lottery.pdf" },
        { title: "Waldspurger, Lottery and Stride Scheduling (MIT thesis)", href: "https://publications.csail.mit.edu/lcs/pubs/pdf/MIT-LCS-TR-667.pdf" },
      ]} />
    </PgFrame>
  );
}
