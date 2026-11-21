"use client";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  ANSWER, BATCH, CAP, CHALLENGES, ROLE, TIDS, canStep, init, isStalled, lines, revealed, step,
  type Batch, type Guard, type Guess, type State, type Tid, type Wake,
} from "./model";

const CSS = `
.mcv-stage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1fr); gap: 10px; align-items: start; }
@media (max-width: 640px) { .mcv-stage { grid-template-columns: 1fr; } }
.mcv-col { display: grid; gap: 8px; }
.mcv-th { border: 1px solid var(--line); background: var(--surface); padding: 8px; display: grid; gap: 6px; }
.mcv-th.waiting { border-style: dashed; background: var(--bg); }
.mcv-th.woken { border-color: var(--accent); }
.mcv-th.crashed { border-color: var(--pain); background: var(--pain-bg); }
.mcv-th header { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
.mcv-name { font-family: var(--f-code); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }
.mcv-st { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; padding: 1px 5px; border: 1px solid var(--line); color: var(--ink-2); }
.mcv-th.waiting .mcv-st { color: var(--ink-2); border-style: dashed; }
.mcv-th.woken .mcv-st { color: var(--accent); border-color: var(--accent); font-weight: 700; }
.mcv-th.crashed .mcv-st { color: var(--pain); border-color: var(--pain); font-weight: 700; }
.mcv-code { margin: 0; padding: 0; list-style: none; font-family: var(--f-code); font-size: .74rem; display: grid; gap: 2px; }
.mcv-code li { padding: 2px 6px; border-left: 3px solid transparent; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mcv-code li.next { border-left-color: var(--accent); background: var(--hl); color: var(--ink); font-weight: 600; }
.mcv-code li.guard { color: var(--ink); }
.mcv-code li.guard b { color: var(--accent); }
.mcv-btns { display: flex; gap: 6px; flex-wrap: wrap; }
.mcv-mon { border: 2px solid var(--accent); background: var(--surface); padding: 8px; display: grid; gap: 8px; }
.mcv-lock { font-family: var(--f-code); font-size: .7rem; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line); padding: 3px 6px; justify-self: start; }
.mcv-lock.held { border-color: var(--accent); color: var(--accent); font-weight: 700; }
.mcv-queue { display: flex; gap: 4px; }
.mcv-slot { flex: 1; border: 1px solid var(--line); background: var(--bg); min-height: 2.2em; display: flex; align-items: center; justify-content: center; font-family: var(--f-code); font-size: .85rem; font-weight: 600; }
.mcv-slot.full { background: var(--hl); border-color: var(--accent); }
.mcv-slot.over { background: var(--pain-bg); border-color: var(--pain); color: var(--pain); }
.mcv-ws { border: 1px dashed var(--line); padding: 4px 6px; min-height: 3em; display: flex; flex-wrap: wrap; gap: 4px; align-content: flex-start; }
.mcv-ws span { font-family: var(--f-code); font-size: .72rem; border: 1px solid var(--ink-2); padding: 1px 6px; }
.mcv-ws span.cons { border-color: var(--ink-2); }
.mcv-ws span.prod { border-color: var(--accent); color: var(--accent); }
.mcv-fresh { animation: pg-hop .3s var(--ease) both; }
.mcv-alert { margin: 0; padding: 6px 8px; border: 1px solid var(--pain); background: var(--pain-bg); color: var(--pain); font-size: .9rem; }
.mcv-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.mcv-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.mcv-goals li { font-size: .9rem; padding-left: 1.6em; position: relative; }
.mcv-goals li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.mcv-goals li.met::before { content: "✓"; color: var(--good); font-weight: 700; }
.mcv-runs { width: 100%; border-collapse: collapse; font-size: .85rem; }
.mcv-runs th, .mcv-runs td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.mcv-runs th:first-child, .mcv-runs td:first-child { text-align: left; }
.mcv-runs th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.mcv-runs td.bad { color: var(--pain); font-weight: 700; }
.mcv-runs td.good { color: var(--good); font-weight: 700; }
@media (prefers-reduced-motion: reduce) { .mcv-fresh { animation: none; } }
`;

const STATUS: Record<State["th"][Tid]["status"], string> = { ready: "running", waiting: "waiting on cv", woken: "woken · needs lock", crashed: "crashed" };
const JOB: Record<Tid, string> = { P1: "producer", C1: "consumer", C2: "consumer" };

const GUESSES: { value: Guess; label: string }[] = [
  { value: "waits", label: "It goes back to waiting" },
  { value: "crash", label: "It takes from the empty queue" },
  { value: "gets", label: "It gets the job it was woken for" },
];

function ThreadCard({ st, t, dispatch, reduced }: { st: State; t: Tid; dispatch: (a: { type: "step" | "spurious"; t: Tid }) => void; reduced: boolean }) {
  const th = st.th[t];
  const src = lines(st, t);
  const ok = canStep(st, t);
  const label = th.status === "crashed" ? "crashed" : th.status === "waiting" ? "asleep" : th.status === "woken" ? (ok ? "Retake lock" : "needs lock") : ok ? `Step ${t}` : "needs lock";
  return (
    <div className={`mcv-th ${th.status}`}>
      <header>
        <span className="mcv-name">{t} · {JOB[t]}</span>
        <span key={th.status} className={"mcv-st" + (reduced ? "" : " mcv-fresh")}>{STATUS[th.status]}</span>
      </header>
      <ol className="mcv-code" aria-label={`${t}'s code`}>
        {src.map((l, i) => {
          const next = th.status === "ready" && i === th.pc;
          const word = i === 1 ? l.split(" ")[0] : null;
          return (
            <li key={i} className={(next ? "next " : "") + (i === 1 ? "guard" : "")}>
              {word ? <><b>{word}</b>{l.slice(word.length)}</> : l}
            </li>
          );
        })}
      </ol>
      <div className="mcv-btns">
        <PgButton primary={ok} onClick={() => dispatch({ type: "step", t })} disabled={!ok}
          title={ok ? `Run ${t}'s next line` : th.status === "waiting" ? `${t} sleeps until someone signals` : `${t} cannot run now`}>{label}</PgButton>
        {th.status === "waiting" && (
          <PgButton onClick={() => dispatch({ type: "spurious", t })} title="Wake this thread with no signal, as the OS is allowed to">Spurious wakeup</PgButton>
        )}
      </div>
    </div>
  );
}

function Monitor({ st, reduced }: { st: State; reduced: boolean }) {
  const slots = Math.max(CAP, st.queue.length);
  return (
    <div className="mcv-mon" aria-label="The monitor: lock, queue and wait set">
      <span className="label">Monitor · one lock, one condition</span>
      <span className={"mcv-lock" + (st.holder ? " held" : "")}>mu: {st.holder ? `held by ${st.holder}` : "free"}</span>
      <span className="label">Job queue · capacity {CAP}</span>
      <div className="mcv-queue">
        {Array.from({ length: slots }, (_, i) => {
          const j = st.queue[i];
          return <span key={i + ":" + (j ?? "")} className={"mcv-slot" + (j !== undefined ? (i >= CAP ? " over" : " full") : "") + (j !== undefined && !reduced ? " mcv-fresh" : "")}>{j !== undefined ? `#${j}` : "empty"}</span>;
        })}
      </div>
      <span className="label">cv wait set · oldest first</span>
      <div className="mcv-ws" aria-label="Threads waiting on the condition variable">
        {st.waitSet.length === 0 ? <span style={{ border: "none" }} className="muted">nobody waiting</span>
          : st.waitSet.map((t, i) => <span key={t} className={ROLE[t]}>{i + 1}. {t}</span>)}
      </div>
    </div>
  );
}

const cfg = (b: { guard: Guard; wake: Wake }) => `${b.guard} + ${b.wake}`;

function Batches({ batches }: { batches: Batch[] }) {
  if (!batches.length) return null;
  return (
    <table className="mcv-runs">
      <caption className="label" style={{ textAlign: "left" }}>{BATCH} random schedules each, with rare spurious wakeups</caption>
      <thead><tr><th>Code</th><th>Crashed</th><th>All asleep</th><th>Fine</th><th>Wasted wakeups</th></tr></thead>
      <tbody>
        {batches.map((b) => (
          <tr key={cfg(b)}>
            <td>{cfg(b)}</td>
            <td className={b.crashed ? "bad" : ""}>{b.crashed}</td>
            <td className={b.stalled ? "bad" : ""}>{b.stalled}</td>
            <td className={b.ok === b.runs ? "good" : ""}>{b.ok}</td>
            <td>{b.useless}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ st }: { st: State }) {
  const find = (g: Guard, w: Wake) => st.batches.find((b) => b.guard === g && b.wake === w);
  const bad = st.batches.filter((b) => b.crashed + b.stalled > 0);
  const clean = st.batches.find((b) => b.crashed + b.stalled === 0);
  if (st.batches.length < 2 && st.stats.crashes + st.stats.stalls === 0) return null;
  const ifs = find("if", "signal") ?? find("if", "broadcast");
  const ws = find("while", "signal");
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your numbers</span>
      <p>
        By hand: {st.stats.crashes + st.stats.overflows} crash{st.stats.crashes + st.stats.overflows === 1 ? "" : "es"}, {st.stats.stalls} time{st.stats.stalls === 1 ? "" : "s"} everyone fell asleep, {st.stats.useless} wakeup{st.stats.useless === 1 ? "" : "s"} for nothing.
        {ifs && <> With {cfg(ifs)}, {ifs.crashed} of {ifs.runs} random runs crashed.</>}
        {ws && <> With while + signal, {ws.stalled} of {ws.runs} ended with every thread asleep.</>}
        {clean && <> With {cfg(clean)}, all {clean.runs} were fine, at the cost of {clean.useless} wasted wakeups.</>}
      </p>
      <p className="pg-takeaway">
        Waking up only means &quot;look again&quot;: by the time a woken thread holds the lock, the job may be gone, or there was never
        a signal at all. So the check goes in a while loop. And when producers and consumers share one condition, signal can wake
        the wrong kind of thread; broadcast, or one condition per predicate, makes sure the right one hears.
        {bad.length > 0 && !clean ? " Try the other combinations and run them too." : ""}
      </p>
    </div>
  );
}

export default function MonitorsAndConditionVariables() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const stalled = isStalled(st);
  return (
    <PgFrame title="Bounded queue by hand" onReset={() => dispatch({ type: "reset" })}
      toolbar={<PgButton onClick={() => dispatch({ type: "restart" })}>Start threads again</PgButton>}>
      <style>{CSS}</style>
      <p className="pg-rule">
        One producer and two consumers share a job queue that holds one job. A lock guards it, and every thread waits on the same
        condition variable. <b>Step each thread one line at a time. A woken thread must get the lock back before it continues,
        and anything can happen in between.</b>
      </p>

      <PgPredict<Guess>
        question="C1 waits on the empty queue. P1 puts a job and signals, which wakes C1. Before C1 gets the lock back, C2 takes the job. The code says if queue.empty(): cv.wait(). What does C1 do once it has the lock?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed(st)}
        answer={ANSWER}
        explain="With if, returning from wait() means carry on. C1 never looks at the queue again, so it calls take() on an empty queue and crashes. A while loop would check again and go back to waiting. To see it: step C1 until it waits, then P1 through its signal and unlock, then C2 all the way, then C1."
      />

      <div className="mcv-row">
        <span className="label">Guard</span>
        <PgChoice<Guard> label="Guard around wait" value={st.guard}
          options={[{ value: "if", label: "if … wait()" }, { value: "while", label: "while … wait()" }]}
          onChange={(g) => dispatch({ type: "guard", guard: g })} />
        <span className="label">Wake</span>
        <PgChoice<Wake> label="How to wake waiters" value={st.wake}
          options={[{ value: "signal", label: "signal · wake one" }, { value: "broadcast", label: "broadcast · wake all" }]}
          onChange={(w) => dispatch({ type: "wake", wake: w })} />
      </div>

      <div className="mcv-stage">
        <div className="mcv-col"><ThreadCard st={st} t="P1" dispatch={dispatch} reduced={reduced} /></div>
        <Monitor st={st} reduced={reduced} />
        <div className="mcv-col">
          {(["C1", "C2"] as Tid[]).map((t) => <ThreadCard key={t} st={st} t={t} dispatch={dispatch} reduced={reduced} />)}
        </div>
      </div>

      {stalled && <p className="mcv-alert" role="status">All threads are asleep in the wait set and nobody is left to signal. Nothing will ever happen again: a lost wakeup. Try a spurious wakeup, or start again with broadcast.</p>}
      {TIDS.some((t) => st.th[t].status === "crashed") && <p className="mcv-alert" role="status">A consumer crashed taking from an empty queue. Start the threads again, or switch the guard to while.</p>}

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">What happened, newest first</span>
          <PgLog entries={st.log} empty="Nothing yet. Step C1 first: it finds the queue empty and waits." reduced={reduced} />
        </div>
        <div className="pg-card">
          <span className="label">Challenges</span>
          <ul className="mcv-goals" aria-label="Challenges">
            {CHALLENGES.map((c) => <li key={c.id} className={st.done.includes(c.id) ? "met" : ""}>{c.text}</li>)}
          </ul>
          <div className="mcv-row">
            <PgButton onClick={() => dispatch({ type: "batch" })} title="Random schedules of the current code, with a small chance of spurious wakeups">Run {BATCH} random schedules</PgButton>
          </div>
          <Batches batches={st.batches} />
          <dl className="pg-stats">
            <div><dt>Jobs made / taken</dt><dd>{st.stats.produced} / {st.stats.consumed}</dd></div>
            <div><dt>Wakeups</dt><dd>{st.stats.wakeups}</dd></div>
            <div><dt>For nothing</dt><dd>{st.stats.useless}</dd></div>
            <div className={st.stats.crashes + st.stats.overflows ? "bad" : ""}><dt>Crashes</dt><dd>{st.stats.crashes + st.stats.overflows}</dd></div>
          </dl>
        </div>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "OSTEP, Condition Variables (the producer/consumer bugs)", href: "https://pages.cs.wisc.edu/~remzi/OSTEP/threads-cv.pdf" },
        { title: "ThreadMentor's producer/consumer visualisation", href: "https://pages.mtu.edu/~shene/NSF-3/e-Book/MONITOR/ProducerConsumer-1/visual.html" },
        { title: "The Deadlock Empire", href: "https://deadlockempire.github.io/" },
      ]} />
    </PgFrame>
  );
}
