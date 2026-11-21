"use client";
import { useEffect, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  DEADLINE, END, GC_AT, HOG_AT, HOG_MS, MODE_NAME, SLICE_MS, hogOn, init, step, waiting,
  type CellKind, type Guess, type Mode, type RunResult, type State,
} from "./model";

const CSS = `
.pe-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.pe-box { border: 1px solid var(--line); background: var(--surface); padding: 6px; display: grid; gap: 4px; align-content: start; min-height: 58px; }
.pe-box.p { border-color: var(--accent); }
.pe-box.hot { border-color: var(--pain); background: var(--pain-bg); }
.pe-tag { font-family: var(--f-code); font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; }
.pe-sub { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.pe-chip { font-family: var(--f-code); font-size: .62rem; padding: 0 4px; border: 1px solid var(--ink-2); background: var(--bg); justify-self: start; }
.pe-chip.hog { border-color: var(--pain); color: var(--pain); font-weight: 700; }
.pe-tl { display: grid; gap: 2px; }
.pe-lane { display: grid; grid-template-columns: 4.6em 1fr; gap: 4px; align-items: center; }
.pe-cells { display: grid; grid-template-columns: repeat(${END}, minmax(1px, 1fr)); height: 16px; border: 1px solid var(--line); background: var(--bg); }
.pe-cells.thin { height: 8px; }
.pe-c { display: block; height: 100%; }
.pe-c.req { background: var(--accent); }
.pe-c.hog { background: var(--pain); }
.pe-c.stopped { background: repeating-linear-gradient(45deg, var(--ink-2) 0 2px, var(--surface-2) 2px 4px); }
.pe-c.stw { background: var(--ink); }
.pe-c.signal { background: var(--good); }
.pe-c.ask { background: var(--ink); }
.pe-key { display: flex; flex-wrap: wrap; gap: 10px; font-size: .78rem; color: var(--ink-2); }
.pe-key i { display: inline-block; width: 12px; height: 10px; margin-right: 4px; vertical-align: middle; }
.pe-controls { display: grid; gap: 6px; }
.pe-controls > div { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.pe-events { margin: 0; padding-left: 1.1em; font-size: .85rem; color: var(--ink-2); display: grid; gap: 2px; max-height: 150px; overflow: auto; }
.pe-runs { width: 100%; border-collapse: collapse; font-size: .82rem; }
.pe-runs th, .pe-runs td { border: 1px solid var(--line); padding: 3px 5px; text-align: right; font-variant-numeric: tabular-nums; }
.pe-runs th:first-child, .pe-runs td:first-child { text-align: left; }
.pe-runs th { font-family: var(--f-code); font-size: .56rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.pe-runs td.bad { color: var(--pain); font-weight: 700; }
.pe-scroll { overflow-x: auto; }
`;

function Board({ st }: { st: State }) {
  const hp = hogOn(st);
  const gcText = st.gcPhase === "off" ? (st.gc ? `starts at ${GC_AT} ms` : "off in this run")
    : st.gcPhase === "waiting" ? `waiting for ${st.ps.filter((p) => !p.stopped).map((p) => "P" + p.id).join(", ")} to stop`
    : st.gcPhase === "stw" ? "world stopped: GC setup" : `done, paused ${st.pause} ms`;
  return (
    <div className="pe-board">
      {st.ps.map((p) => (
        <div key={p.id} className={"pe-box p" + (p.run?.kind === "hog" && st.gcPhase === "waiting" ? " hot" : "")}>
          <span className="pe-tag">P{p.id}</span>
          <span className="pe-sub">{p.stopped ? "stopped for the GC" : p.run ? (p.run.kind === "hog" ? `in the loop for ${st.t - p.since} ms` : "serving a request") : "idle"}</span>
          {p.run && <span className={"pe-chip " + p.run.kind}>{p.run.kind === "hog" ? "fingerprint loop" : `request #${p.run.id}`}</span>}
        </div>
      ))}
      <div className="pe-box">
        <span className="pe-tag">Global queue</span>
        <span className="pe-sub">{waiting(st)} requests waiting{st.queue.some((i) => i.kind === "hog") ? " + the loop" : ""}</span>
      </div>
      <div className={"pe-box" + (st.gcPhase === "waiting" ? " hot" : "")}>
        <span className="pe-tag">GC</span>
        <span className="pe-sub">{gcText}</span>
      </div>
      <div className="pe-box">
        <span className="pe-tag">The loop</span>
        <span className="pe-sub">{st.hogDoneAt !== null ? `done at ${st.hogDoneAt} ms` : st.t < HOG_AT ? `starts at ${HOG_AT} ms` : `${HOG_MS - st.hogLeft} of ${HOG_MS} ms done${hp ? "" : ", waiting"}`}</span>
      </div>
    </div>
  );
}

function Timeline({ st }: { st: State }) {
  const markAt = new Map(st.marks.map((m) => [m.t, m.kind] as const));
  return (
    <div className="pe-scroll">
      <div className="pe-tl" role="img" aria-label={`Timeline of ${st.ps.length} Ps over ${END} ms`}>
        {st.ps.map((p) => (
          <div key={p.id} className="pe-lane">
            <span className="pe-sub">P{p.id}</span>
            <div className="pe-cells">
              {Array.from({ length: END }, (_, t) => {
                const c: CellKind | undefined = st.timeline[t]?.[p.id];
                return <i key={t} className={"pe-c" + (c && c !== "idle" ? ` ${c}` : "")} />;
              })}
            </div>
          </div>
        ))}
        <div className="pe-lane">
          <span className="pe-sub">signals</span>
          <div className="pe-cells thin">
            {Array.from({ length: END }, (_, t) => {
              const k = markAt.get(t);
              return <i key={t} className={"pe-c" + (k === "signal" ? " signal" : k === "ask" ? " ask" : "")} />;
            })}
          </div>
        </div>
      </div>
      <div className="pe-key">
        <span><i className="pe-c req" />request</span>
        <span><i className="pe-c hog" />fingerprint loop</span>
        <span><i className="pe-c stopped" />stopped, waiting for the world</span>
        <span><i className="pe-c stw" />stop-the-world work</span>
        <span><i className="pe-c signal" />SIGURG</span>
      </div>
    </div>
  );
}

function Stats({ st }: { st: State }) {
  return (
    <dl className="pg-stats">
      <div><dt>Time</dt><dd>{st.t} ms</dd></div>
      <div><dt>Requests served</dt><dd>{st.served}</dd></div>
      <div className={st.worstWait > DEADLINE ? "bad" : ""}><dt>Worst request wait</dt><dd>{st.worstWait} ms</dd></div>
      <div className={st.late ? "bad" : ""}><dt>Over {DEADLINE} ms</dt><dd>{st.late}</dd></div>
      <div className={st.pause !== null && st.pause > 5 ? "bad" : st.gcPhase === "waiting" ? "bad" : ""}><dt>GC pause</dt><dd>{st.pause !== null ? `${st.pause} ms` : st.gcPhase === "waiting" || st.gcPhase === "stw" ? `${st.t - (st.gcAskedAt ?? st.t)} ms…` : "–"}</dd></div>
      <div><dt>Signals sent</dt><dd>{st.signals}</dd></div>
      <div><dt>Gosched yields</dt><dd>{st.yields}</dd></div>
      <div><dt>Loop done at</dt><dd>{st.hogDoneAt !== null ? `${st.hogDoneAt} ms` : "–"}</dd></div>
    </dl>
  );
}

const label = (r: RunResult) => `${MODE_NAME[r.mode]}, ${r.procs} P${r.procs > 1 ? "s" : ""}${r.gc ? "" : ", no GC"}`;

function Runs({ runs }: { runs: RunResult[] }) {
  if (!runs.length) return null;
  return (
    <div className="pe-scroll">
      <table className="pe-runs">
        <caption className="label" style={{ textAlign: "left" }}>Your runs</caption>
        <thead><tr><th>Run</th><th>GC pause</th><th>Worst wait</th><th>Late</th><th>Loop done</th></tr></thead>
        <tbody>
          {runs.map((r, i) => (
            <tr key={i}>
              <td>{label(r)}</td>
              <td className={r.pauseMs !== null && r.pauseMs > 5 ? "bad" : ""}>{r.pauseMs === null ? "–" : `${r.pauseMs} ms`}</td>
              <td className={r.worstWaitMs > DEADLINE ? "bad" : ""}>{r.worstWaitMs} ms</td>
              <td className={r.late ? "bad" : ""}>{r.late}</td>
              <td>{r.hogDoneAt} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Result({ runs }: { runs: RunResult[] }) {
  const last = (mode: Mode) => [...runs].reverse().find((r) => r.mode === mode && r.gc);
  const coop = last("coop"), fixed = (coop && [...runs].reverse().find((r) => r.mode !== "coop" && r.gc && r.procs === coop.procs)) || undefined;
  if (!coop || !fixed) {
    return <p className="muted" aria-live="polite">{runs.length ? "Now run the same setup in another mode and compare the rows." : ""}</p>;
  }
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>With {coop.procs} P{coop.procs > 1 ? "s" : ""} and cooperative preemption only, the GC waited for the loop: the program paused <b>{coop.pauseMs} ms</b> and a request waited <b>{coop.worstWaitMs} ms</b>.
        {" "}With {MODE_NAME[fixed.mode].toLowerCase()}, the pause was <b>{fixed.pauseMs} ms</b> and the worst wait <b>{fixed.worstWaitMs} ms</b>. The loop itself finished at {fixed.hogDoneAt} ms instead of {coop.hogDoneAt} ms.</p>
      <p className="pg-takeaway">Stopping the world needs every goroutine to stop. Before Go 1.14 a goroutine could only stop at a function call, so one loop without calls held the whole program. Signals make every goroutine stoppable within a moment; the loop pays by sharing its CPU.</p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "p1", label: "About 1 ms: P1 keeps serving" },
  { value: "slice", label: `About ${SLICE_MS} ms: one time slice` },
  { value: "loop", label: "Until the loop ends, over 60 ms" },
];

export default function Preemption() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const done = st.recorded;
  useEffect(() => {
    if (!playing || done) { if (done) setPlaying(false); return; }
    const id = setInterval(() => dispatch({ type: "tick" }), reduced ? 30 : 70);
    return () => clearInterval(id);
  }, [playing, done, reduced, dispatch]);
  const stop = () => setPlaying(false);
  const revealed = st.runs.some((r) => r.mode === "coop" && r.gc);

  return (
    <PgFrame title="Stop a loop that never calls" onReset={() => { stop(); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <p className="pg-rule">
        A backup service fingerprints a 1 GiB image in a loop with no function calls ({HOG_MS} ms here). Requests arrive every 2 ms and
        must start within {DEADLINE} ms. At {GC_AT} ms a garbage collection needs to stop the world. <b>Pick the Go version, run it, and watch who waits.</b>
      </p>

      <PgPredict<Guess>
        question={`GOMAXPROCS is 2, so P1 is free while the loop runs on P0. On Go 1.13, the GC starts at ${GC_AT} ms. How long can a request wait?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed}
        answer="loop"
        explain="The GC must stop every P before it can start. P1 stops at once. P0 can only stop at a function call, and the loop makes none, so the whole program, P1 included, waits until the loop ends."
      />

      <div className="pe-controls">
        <div><span className="pe-sub">Preemption</span>
          <PgChoice<Mode> label="Preemption" value={st.mode}
            options={(["coop", "gosched", "async"] as Mode[]).map((m) => ({ value: m, label: MODE_NAME[m] }))}
            onChange={(m) => { stop(); dispatch({ type: "mode", mode: m }); }} />
        </div>
        <div><span className="pe-sub">GOMAXPROCS</span>
          <PgChoice label="GOMAXPROCS" value={String(st.procs)} options={[{ value: "1", label: "1" }, { value: "2", label: "2" }]}
            onChange={(v) => { stop(); dispatch({ type: "procs", procs: +v }); }} />
          <span className="pe-sub">GC at {GC_AT} ms</span>
          <PgChoice label="Garbage collection" value={st.gc ? "on" : "off"} options={[{ value: "on", label: "on" }, { value: "off", label: "off" }]}
            onChange={(v) => { stop(); dispatch({ type: "gc", on: v === "on" }); }} />
        </div>
        <div>
          <PgButton primary onClick={() => setPlaying((p) => !p)} disabled={done}>{playing ? "Pause" : st.t ? "Resume" : "Run"}</PgButton>
          <PgButton onClick={() => dispatch({ type: "tick" })} disabled={done || playing}>Step 1 ms</PgButton>
          <PgButton onClick={() => { stop(); dispatch({ type: "finish" }); }} disabled={done}>Skip to the end</PgButton>
          {done && <PgButton onClick={() => dispatch({ type: "clear" })}>Clear the board</PgButton>}
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Right now</span>
        <Board st={st} />
        <span className="label">Each P, millisecond by millisecond</span>
        <Timeline st={st} />
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <Stats st={st} />
          <ol className="pe-events" aria-live="polite">
            {st.events.slice(0, 8).map((e, i) => <li key={st.events.length - i}>{e}</li>)}
          </ol>
        </div>
        <div className="pg-card">
          <Runs runs={st.runs} />
          <Result runs={st.runs} />
          <p className="pg-note">Model scale: 1 ms ticks. Real stop-the-world pauses take tens to hundreds of microseconds, and a GC cycle has two of them; this shows the first. Gosched mode is the pre-1.14 workaround: an explicit yield after every MiB.</p>
        </div>
      </div>

      <PgSources links={[
        { title: "Austin Clements, Proposal: non-cooperative goroutine preemption", href: "https://github.com/golang/proposal/blob/master/design/24543-non-cooperative-preemption.md" },
        { title: "Vincent Blanchon, Go: Asynchronous Preemption", href: "https://medium.com/a-journey-with-go/go-asynchronous-preemption-b5194227371c" },
        { title: "the comments in runtime/preempt.go", href: "https://github.com/golang/go/blob/master/src/runtime/preempt.go" },
      ]} />
    </PgFrame>
  );
}
