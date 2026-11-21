"use client";
import { useEffect, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CORES, JOBS, JOB_TICKS, LOCAL_CAP, MAX_PROCS, PROBE_AT, SPAWN_OPTIONS, TICK_MS, init, queued, running, spawnName, step,
  type G, type Guess, type RunResult, type State,
} from "./model";

const CSS = `
.gmp-board { display: grid; gap: 8px; }
.gmp-ps { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.gmp-p { border: 1px solid var(--line); background: var(--surface); padding: 6px; display: grid; gap: 6px; align-content: start; }
.gmp-p.idle { border-style: dashed; }
.gmp-p header { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.gmp-tag { font-family: var(--f-code); font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; }
.gmp-sub { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.gmp-run { display: grid; grid-template-columns: auto 1fr; gap: 6px; align-items: center; border: 1px solid var(--line); background: var(--bg); padding: 4px; }
.gmp-m { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; border: 1px solid var(--ink-2); padding: 2px 4px; }
.gmp-m.parked { color: var(--ink-2); border-style: dashed; }
.gmp-q { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; }
.gmp-slot { height: 14px; border: 1px solid var(--line); background: var(--bg); }
.gmp-g { height: 14px; border: 1px solid var(--ink-2); background: var(--surface-2); font-family: var(--f-code); font-size: .5rem; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.gmp-g.probe { background: var(--pain-bg); border-color: var(--pain); color: var(--pain); font-weight: 700; }
.gmp-g.run { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); height: 18px; padding: 0 4px; font-size: .62rem; justify-content: flex-start; }
.gmp-g.run.probe { background: var(--pain); border-color: var(--pain); color: var(--surface); }
.gmp-g.over { outline: 1px dashed var(--pain); }
.gmp-fresh { animation: pg-hop .3s var(--ease) both; }
.gmp-global { border: 1px solid var(--line); background: var(--surface); padding: 6px; display: grid; gap: 4px; }
.gmp-global .gmp-q { grid-template-columns: repeat(auto-fill, 14px); }
.gmp-global .gmp-g { width: 14px; }
.gmp-spark { display: flex; align-items: flex-end; gap: 1px; height: 30px; border-bottom: 1px solid var(--line); overflow: hidden; }
.gmp-spark i { flex: 1 0 2px; max-width: 6px; background: var(--accent); display: block; }
.gmp-runs { width: 100%; border-collapse: collapse; font-size: .85rem; }
.gmp-runs th, .gmp-runs td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.gmp-runs th:first-child, .gmp-runs td:first-child { text-align: left; }
.gmp-runs th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.gmp-runs td.bad { color: var(--pain); font-weight: 700; }
.gmp-controls { display: grid; gap: 6px; }
.gmp-controls > div { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.gmp-events { margin: 0; padding-left: 1.1em; font-size: .85rem; color: var(--ink-2); display: grid; gap: 2px; max-height: 120px; overflow: auto; }
@media (prefers-reduced-motion: reduce) { .gmp-fresh { animation: none; } }
`;

const ms = (ticks: number) => `${ticks * TICK_MS} ms`;

function Chip({ g, run }: { g: G; run?: boolean }) {
  const label = g.kind === "probe" ? (run ? "/healthz" : "H") : run ? (g.kind === "worker" ? `worker G${g.id}` : `G${g.id} resize`) : String(g.id);
  return <span className={"gmp-g" + (run ? " run" : "") + (g.kind === "probe" ? " probe" : "")} title={g.kind === "probe" ? "the /healthz goroutine" : `G${g.id}`}>{label}</span>;
}

function Board({ st, reduced }: { st: State; reduced: boolean }) {
  return (
    <div className="gmp-board">
      <div className="gmp-ps">
        {st.ps.map((p) => {
          const g = p.run !== null ? st.gs[p.run] : null;
          const slots = Math.max(LOCAL_CAP, p.q.length);
          return (
            <div key={p.id} className={"gmp-p" + (g ? "" : " idle")} aria-label={`P${p.id}: ${g ? "running G" + g.id : "idle"}, ${p.q.length} waiting`}>
              <header>
                <span className="gmp-tag">P{p.id}</span>
                <span className="gmp-sub">{p.q.length} waiting</span>
              </header>
              <div className="gmp-run">
                <span className={"gmp-m" + (g ? "" : " parked")} title="The OS thread that holds this P">M{p.id}</span>
                {g ? <span key={g.id + ":" + st.t} className={reduced ? "" : "gmp-fresh"}><Chip g={g} run /></span> : <span className="gmp-sub">{st.started ? "nothing to run" : "idle"}</span>}
              </div>
              <div className="gmp-q" aria-hidden="true">
                {Array.from({ length: slots }, (_, i) => {
                  const id = p.q[i];
                  return id === undefined ? <span key={i} className="gmp-slot" /> : <Chip key={i} g={st.gs[id]} />;
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="gmp-global">
        <header style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="gmp-tag">Global run queue</span>
          <span className="gmp-sub">{st.global.length} waiting</span>
        </header>
        <div className="gmp-q" aria-label={`Global run queue: ${st.global.length} goroutines`}>
          {st.global.length === 0 ? <span className="gmp-sub">empty</span> : st.global.map((id) => <Chip key={id} g={st.gs[id]} />)}
        </div>
      </div>
    </div>
  );
}

function Stats({ st }: { st: State }) {
  const probe = st.probeId !== null ? st.gs[st.probeId] : null;
  const wait = probe ? ((probe.finished ?? st.t) - probe.born) : null;
  const r = running(st);
  return (
    <dl className="pg-stats">
      <div><dt>Time</dt><dd>{ms(st.t)}</dd></div>
      <div><dt>Running now</dt><dd>{r} of {st.procs} Ps</dd></div>
      <div className={queued(st) > st.procs * 2 ? "bad" : ""}><dt>Waiting in queues</dt><dd>{queued(st)}</dd></div>
      <div><dt>Thumbnails</dt><dd>{st.jobsDone} / {JOBS}</dd></div>
      <div><dt>Threads running Go</dt><dd>{r}{st.procs > CORES ? ` on ${CORES} cores` : ""}</dd></div>
      <div><dt>Goroutines</dt><dd>{Object.values(st.gs).filter((g) => g.finished === null).length}</dd></div>
      <div className={wait !== null && wait * TICK_MS > 50 ? "bad" : ""}><dt>/healthz wait</dt><dd>{wait === null ? "not yet" : `${ms(wait)}${probe!.finished === null ? "…" : ""}`}</dd></div>
      <div><dt>Batch done at</dt><dd>{st.batchDoneAt === null ? "running" : ms(st.batchDoneAt)}</dd></div>
    </dl>
  );
}

function Runs({ runs }: { runs: RunResult[] }) {
  if (!runs.length) return null;
  const worst = Math.max(...runs.map((r) => r.probeWaitMs));
  return (
    <table className="gmp-runs">
      <caption className="label" style={{ textAlign: "left" }}>Your runs</caption>
      <thead><tr><th>Goroutines</th><th>GOMAXPROCS</th><th>Batch</th><th>/healthz</th><th>Most queued</th></tr></thead>
      <tbody>
        {runs.map((r, i) => (
          <tr key={i}>
            <td>{spawnName(r.goroutines)}</td><td>{r.procs}</td><td>{r.batchMs} ms</td>
            <td className={r.probeWaitMs === worst && runs.length > 1 ? "bad" : ""}>{r.probeWaitMs} ms</td><td>{r.maxQueued}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ runs }: { runs: RunResult[] }) {
  // Compare one-per-image with a small worker count at the same GOMAXPROCS.
  const many = [...runs].reverse().find((r) => r.goroutines >= JOBS);
  const few = many && [...runs].reverse().find((r) => r.procs === many.procs && r.goroutines < JOBS && r.goroutines >= Math.min(many.procs, CORES));
  if (!many || !few) {
    return <p className="muted" aria-live="polite">{runs.length ? "Now run the same batch with the other design at the same GOMAXPROCS, and compare the rows." : ""}</p>;
  }
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>With GOMAXPROCS {many.procs}: <b>{JOBS} goroutines</b> finished the batch in {many.batchMs} ms and made /healthz wait {many.probeWaitMs} ms. <b>{spawnName(few.goroutines)}</b> finished in {few.batchMs} ms and /healthz waited {few.probeWaitMs} ms.</p>
      <p className="pg-takeaway">At most {Math.min(many.procs, CORES)} goroutines run at any moment, one per P on a core. The other {JOBS - Math.min(many.procs, CORES)} did not make the batch faster; they stood in the queues, and /healthz stood behind them. At 50,000 images the same queue is seconds long.</p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "spawn", label: "64 goroutines, far sooner" },
  { value: "same", label: "About the same time" },
  { value: "pool", label: "4 workers, far sooner" },
];

export default function GmpSchedulerBoard() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const finished = st.recorded;
  useEffect(() => {
    if (!playing || finished) { if (finished) setPlaying(false); return; }
    const t = setInterval(() => dispatch({ type: "tick" }), reduced ? 60 : 140);
    return () => clearInterval(t);
  }, [playing, finished, reduced, dispatch]);
  const play = () => { if (!st.started) dispatch({ type: "start" }); setPlaying((p) => !p); };
  const ran = (n: (g: number) => boolean) => st.runs.some((r) => n(r.goroutines));
  const revealed = ran((g) => g >= JOBS) && ran((g) => g < JOBS);

  return (
    <PgFrame title="Scheduler board" onReset={() => { setPlaying(false); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <p className="pg-rule">
        A thumbnail exporter resizes {JOBS} images, each {JOB_TICKS * TICK_MS} ms of CPU, on a machine with {CORES} cores.
        At {ms(PROBE_AT)} a load balancer sends <code>GET /healthz</code>. <b>Each P runs one goroutine at a time on the M (OS thread)
        that holds it. Everything else waits in a queue.</b> Choose how many goroutines main starts, run the batch, and compare.
      </p>

      <PgPredict<Guess>
        question={`GOMAXPROCS is 4. One version starts ${JOBS} goroutines, one per image. The other starts 4 workers that take images from a channel. Which finishes the batch first?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed}
        answer="same"
        explain={`Both finish together: ${CORES} cores do the same ${JOBS * JOB_TICKS * TICK_MS} ms of CPU work either way. The extra goroutines only wait in run queues, and /healthz waits behind them.`}
      />

      <div className="gmp-controls">
        <div><span className="gmp-sub">GOMAXPROCS (Ps)</span>
          <PgChoice label="GOMAXPROCS" value={String(st.procs)} options={[1, 2, 4, MAX_PROCS].map((n) => ({ value: String(n), label: String(n), note: n > CORES ? `More Ps than the ${CORES} cores` : undefined }))}
            onChange={(v) => dispatch({ type: "procs", procs: +v })} />
        </div>
        <div><span className="gmp-sub">Goroutines main starts</span>
          <PgChoice label="Goroutines main starts" value={String(st.spawn)} options={SPAWN_OPTIONS.map((n) => ({ value: String(n), label: spawnName(n) }))}
            onChange={(v) => { setPlaying(false); dispatch({ type: "spawn", spawn: +v }); }} />
        </div>
        <div>
          <PgButton primary onClick={play} disabled={finished}>{playing ? "Pause" : st.started ? "Resume" : "Run the batch"}</PgButton>
          <PgButton onClick={() => { if (!st.started) dispatch({ type: "start" }); else dispatch({ type: "tick" }); }} disabled={finished || playing}>Step {TICK_MS} ms</PgButton>
          <PgButton onClick={() => { setPlaying(false); dispatch({ type: "finish" }); }} disabled={finished}>Skip to the end</PgButton>
          {finished && <PgButton onClick={() => dispatch({ type: "spawn", spawn: st.spawn })}>Clear the board</PgButton>}
        </div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Ps, Ms and run queues ({LOCAL_CAP} slots shown; the runtime has 256)</span>
          <Board st={st} reduced={reduced} />
          <span className="gmp-sub">Cores busy per tick</span>
          <div className="gmp-spark" aria-label="Cores busy per tick">
            {st.history.map((h, i) => <i key={i} style={{ height: `${(h / CORES) * 100}%` }} />)}
          </div>
        </div>
        <div className="pg-card">
          <Stats st={st} />
          <ol className="gmp-events" reversed aria-live="polite">
            {st.events.slice(0, 8).map((e, i) => <li key={st.events.length - i}>{e}</li>)}
          </ol>
          <Runs runs={st.runs} />
          <Result runs={st.runs} />
          <p className="pg-note">Try GOMAXPROCS {MAX_PROCS} too: twice the Ps, the same {CORES} cores. A model, scaled down: one tick is {TICK_MS} ms, a goroutine is preempted after a 10 ms slice, and a preempted goroutine goes to the back of its own P&apos;s queue.</p>
        </div>
      </div>

      <PgSources links={[
        { title: "Ardan Labs, Scheduling in Go part II", href: "https://www.ardanlabs.com/blog/2018/08/scheduling-in-go-part2.html" },
        { title: "Kavya Joshi, The Scheduler Saga (GopherCon 2018)", href: "https://www.youtube.com/watch?v=YHRO5WQGh0k" },
        { title: "Dmitry Vyukov's scheduler design doc", href: "https://golang.org/s/go11sched" },
      ]} />
    </PgFrame>
  );
}
