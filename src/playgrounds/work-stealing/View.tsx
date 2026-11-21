"use client";
import { useEffect, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BURST, MODE_NAME, PROCS, ideal, init, moved, queued, step, totalWork,
  type Guess, type Lengths, type Mode, type Placement, type RunResult, type State,
} from "./model";

const CSS = `
.ws-ps { display: grid; grid-template-columns: repeat(${PROCS}, minmax(0, 1fr)); gap: 6px; }
.ws-p { border: 1px solid var(--line); background: var(--surface); padding: 5px; display: grid; gap: 4px; align-content: start; min-width: 0; }
.ws-p.idle { border-style: dashed; }
.ws-p.idle.waste { border-color: var(--pain); background: var(--pain-bg); }
.ws-p.thief { box-shadow: inset 0 0 0 2px var(--accent); }
.ws-tag { font-family: var(--f-code); font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; }
.ws-sub { font-family: var(--f-code); font-size: .58rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.ws-run { height: 18px; border: 1px solid var(--line); background: var(--bg); font-family: var(--f-code); font-size: .6rem; display: flex; align-items: center; padding: 0 4px; overflow: hidden; white-space: nowrap; }
.ws-run.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.ws-run.on.bg { background: var(--ink-2); border-color: var(--ink-2); color: var(--surface); }
.ws-q { display: flex; flex-direction: column; gap: 1px; min-height: 40px; }
.ws-g { border: 1px solid var(--accent); background: var(--hl); height: 6px; }
.ws-g.bg { border-color: var(--ink-2); background: var(--surface-2); }
.ws-g.stolen { border-color: var(--good); background: var(--good-bg); }
.ws-tl { display: grid; gap: 2px; }
.ws-lane { display: grid; grid-template-columns: 2.6em 1fr; gap: 4px; align-items: center; }
.ws-cells { display: grid; grid-template-columns: repeat(var(--n), minmax(2px, 1fr)); height: 14px; border: 1px solid var(--line); background: var(--bg); }
.ws-c { display: block; height: 100%; }
.ws-c.burst { background: var(--accent); }
.ws-c.burst.away { background: var(--good); }
.ws-c.bg { background: var(--ink-2); }
.ws-c.waste { background: repeating-linear-gradient(45deg, var(--pain) 0 2px, var(--pain-bg) 2px 4px); }
.ws-c.steal { box-shadow: inset 2px 0 0 var(--ink); }
.ws-key { display: flex; flex-wrap: wrap; gap: 10px; font-size: .78rem; color: var(--ink-2); }
.ws-key i { display: inline-block; width: 12px; height: 10px; margin-right: 4px; vertical-align: middle; }
.ws-controls { display: grid; gap: 6px; }
.ws-controls > div { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ws-steals { margin: 0; padding-left: 1.1em; font-size: .85rem; color: var(--ink-2); display: grid; gap: 2px; max-height: 130px; overflow: auto; }
.ws-runs { width: 100%; border-collapse: collapse; font-size: .82rem; }
.ws-runs th, .ws-runs td { border: 1px solid var(--line); padding: 3px 5px; text-align: right; font-variant-numeric: tabular-nums; }
.ws-runs th:first-child, .ws-runs td:first-child { text-align: left; }
.ws-runs th { font-family: var(--f-code); font-size: .56rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.ws-runs td.bad { color: var(--pain); font-weight: 700; }
.ws-fresh { animation: pg-hop .3s var(--ease) both; }
@media (prefers-reduced-motion: reduce) { .ws-fresh { animation: none; } }
`;

function Board({ st, reduced }: { st: State; reduced: boolean }) {
  const lastT = st.t - 1;
  const thieves = new Set(st.steals.filter((x) => x.t === lastT).map((x) => x.thief));
  const waiting = queued(st) > 0;
  return (
    <div className="ws-ps">
      {st.ps.map((p) => {
        const g = p.run !== null ? st.gs[p.run] : null;
        const cell = st.timeline[lastT]?.[p.id];
        const wasIdle = st.t > 0 && cell?.g === null;
        return (
          <div key={p.id} className={"ws-p" + (wasIdle ? " idle" : "") + (wasIdle && waiting ? " waste" : "") + (thieves.has(p.id) ? " thief" : "")}
            aria-label={`P${p.id}: ${p.q.length} goroutines queued`}>
            <span className="ws-tag">P{p.id}</span>
            <span className="ws-sub">{p.q.length} queued</span>
            {g ? <span key={g.id} className={"ws-run on" + (g.burst ? "" : " bg") + (reduced ? "" : " ws-fresh")}>{g.burst ? "parse" : "quiet"} G{g.id}{g.origin !== p.id ? " ←P" + g.origin : ""}</span>
              : <span className="ws-run">{st.done ? "done" : st.t === 0 ? "ready" : waiting ? "idle, work waits" : "idle"}</span>}
            <div className="ws-q" aria-hidden="true">
              {p.q.map((id) => {
                const q = st.gs[id];
                return <span key={id} className={"ws-g" + (q.burst ? "" : " bg") + (q.origin !== p.id ? " stolen" : "")} style={{ width: `${Math.min(100, q.len * 22)}%` }} />;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Timeline({ st }: { st: State }) {
  const n = Math.max(64, st.t);
  const stealAt = new Set(st.steals.map((x) => `${x.t}:${x.thief}`));
  return (
    <div className="ws-tl" role="img" aria-label={`What each P ran, millisecond by millisecond, over ${st.t} ms`}>
      {st.ps.map((p) => (
        <div key={p.id} className="ws-lane">
          <span className="ws-sub">P{p.id}</span>
          <div className="ws-cells" style={{ ["--n" as string]: n }}>
            {Array.from({ length: n }, (_, t) => {
              const c = st.timeline[t]?.[p.id];
              let cls = "ws-c";
              if (c) {
                if (c.g === null) {
                  // idle while some queue still held work?
                  const later = st.timeline.slice(t + 1).some((row) => row.some((x) => x.g !== null));
                  if (later) cls += " waste";
                } else cls += c.burst ? " burst" + (c.origin !== p.id ? " away" : "") : " bg";
                if (stealAt.has(`${t}:${p.id}`)) cls += " steal";
              }
              return <i key={t} className={cls} />;
            })}
          </div>
        </div>
      ))}
      <div className="ws-key">
        <span><i className="ws-c burst" />burst, on P0</span>
        <span><i className="ws-c burst away" />burst, stolen</span>
        <span><i className="ws-c bg" />quiet connection</span>
        <span><i className="ws-c waste" />idle while work waits</span>
      </div>
    </div>
  );
}

function Stats({ st }: { st: State }) {
  return (
    <dl className="pg-stats">
      <div><dt>Time</dt><dd>{st.t} ms</dd></div>
      <div><dt>Best possible</dt><dd>{ideal(st)} ms</dd></div>
      <div className={st.idleWhileWaiting > 10 ? "bad" : ""}><dt>Idle while work waits</dt><dd>{st.idleWhileWaiting} P·ms</dd></div>
      <div><dt>Steals</dt><dd>{st.steals.length}</dd></div>
      <div><dt>Goroutines moved</dt><dd>{moved(st)}</dd></div>
      <div><dt>Still queued</dt><dd>{queued(st)}</dd></div>
      <div><dt>Work</dt><dd>{totalWork(st)} ms</dd></div>
      <div><dt>Cores</dt><dd>{PROCS}</dd></div>
    </dl>
  );
}

const runLabel = (r: RunResult) => `${MODE_NAME[r.mode]}${r.placement === "spread" ? ", spread" : ""}${r.lengths === "uneven" ? ", uneven" : ""}`;

function Runs({ runs }: { runs: RunResult[] }) {
  if (!runs.length) return null;
  return (
    <table className="ws-runs">
      <caption className="label" style={{ textAlign: "left" }}>Your runs</caption>
      <thead><tr><th>Stealing</th><th>Done at</th><th>Idle P·ms</th><th>Steals</th><th>Moved</th></tr></thead>
      <tbody>
        {runs.map((r, i) => (
          <tr key={i}>
            <td>{runLabel(r)}</td>
            <td className={r.makespan > 30 ? "bad" : ""}>{r.makespan} ms</td>
            <td className={r.idleWhileWaiting > 10 ? "bad" : ""}>{r.idleWhileWaiting}</td>
            <td>{r.steals}</td><td>{r.moved}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ runs }: { runs: RunResult[] }) {
  const pick = (m: Mode) => [...runs].reverse().find((r) => r.mode === m && r.placement === "burst");
  const off = pick("off"), half = pick("half"), one = pick("one");
  if (!off || !half) return <p className="muted" aria-live="polite">{runs.length ? "Now run the same burst with the other stealing setting and compare the rows." : ""}</p>;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>The same burst of {BURST} goroutines on P0: with stealing <b>off</b> it finished at {off.makespan} ms, and Ps sat idle for {off.idleWhileWaiting} P·ms while work waited. Stealing <b>half</b> finished at {half.makespan} ms with {half.steals} steals{one ? <>; stealing <b>one at a time</b> needed {one.steals} steals for {one.makespan} ms</> : null}.</p>
      <p className="pg-takeaway">No central queue handed out the work. Idle Ps went and took it from P0's queue, half at a time, so a handful of steals spread {half.moved} goroutines over all {PROCS} cores, and each steal touched P0's queue once instead of once per goroutine.</p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "60", label: "About 60 ms" },
  { value: "32", label: "About 32 ms" },
  { value: "20", label: "About 20 ms" },
];

export default function WorkStealing() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing || st.done) { if (st.done) setPlaying(false); return; }
    const t = setInterval(() => dispatch({ type: "tick" }), reduced ? 60 : 180);
    return () => clearInterval(t);
  }, [playing, st.done, reduced, dispatch]);
  const stop = () => setPlaying(false);
  const recent = [...st.steals].reverse().slice(0, 8);
  const revealed = st.runs.some((r) => r.mode === "half" && r.placement === "burst");

  return (
    <PgFrame title="Steal it" onReset={() => { stop(); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <p className="pg-rule">
        A log-ingest service gets a burst on one connection. Its reader goroutine runs <code>go parse(batch)</code> {BURST} times, and
        every new goroutine joins the queue of the P it was created on: P0. P1 to P3 only have a little work of their own.
        <b> Run it with stealing off, then on, and watch who does the work.</b>
      </p>

      <PgPredict<Guess>
        question={`With stealing off, P0 alone runs the burst and the batch finishes at 64 ms. With stealing on, when does it finish?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed}
        answer="20"
        explain="About 20 ms, within a millisecond of a perfect split of the 76 ms of work over 4 cores. Each idle P takes half of P0's queue, then the others steal from it in turn, so the burst spreads in a few steals."
      />

      <div className="ws-controls">
        <div><span className="ws-sub">Stealing</span>
          <PgChoice<Mode> label="Stealing" value={st.mode} options={[
            { value: "off", label: "off" }, { value: "half", label: "half the queue" }, { value: "one", label: "one at a time (what if)" },
          ]} onChange={(m) => { stop(); dispatch({ type: "mode", mode: m }); }} />
        </div>
        <div><span className="ws-sub">Burst lands</span>
          <PgChoice<Placement> label="Burst lands" value={st.placement} options={[{ value: "burst", label: "all on P0" }, { value: "spread", label: "spread evenly (what if)" }]}
            onChange={(v) => { stop(); dispatch({ type: "placement", placement: v }); }} />
          <span className="ws-sub">Job sizes</span>
          <PgChoice<Lengths> label="Job sizes" value={st.lengths} options={[{ value: "even", label: "equal" }, { value: "uneven", label: "uneven" }]}
            onChange={(v) => { stop(); dispatch({ type: "lengths", lengths: v }); }} />
        </div>
        <div>
          <PgButton primary onClick={() => setPlaying((p) => !p)} disabled={st.done}>{playing ? "Pause" : st.t ? "Resume" : "Run"}</PgButton>
          <PgButton onClick={() => dispatch({ type: "tick" })} disabled={st.done || playing}>Step 1 ms</PgButton>
          <PgButton onClick={() => { stop(); dispatch({ type: "finish" }); }} disabled={st.done}>Skip to the end</PgButton>
          {st.done && <PgButton onClick={() => dispatch({ type: "clear" })}>Clear the board</PgButton>}
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Local run queues (bar length = job size)</span>
        <Board st={st} reduced={reduced} />
        <span className="label">What each P ran, ms by ms</span>
        <Timeline st={st} />
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <Stats st={st} />
          <ol className="ws-steals" aria-live="polite">
            {recent.length === 0 ? <li>No steals yet.</li> : recent.map((x, i) => <li key={st.steals.length - i}>{x.t} ms: P{x.thief} stole {x.n} from P{x.victim}{x.n > 1 ? `, runs one and queues ${x.n - 1}` : ""}.</li>)}
          </ol>
        </div>
        <div className="pg-card">
          <Runs runs={st.runs} />
          <Result runs={st.runs} />
          <p className="pg-note">Model scale: 1 ms ticks, 4 Ps on 4 cores, steal order pseudo-random per tick. The runtime tries up to four rounds over all Ps in random order and takes n − n/2 from the victim.</p>
        </div>
      </div>

      <PgSources links={[
        { title: "Ardan Labs, Scheduling in Go part II (work stealing)", href: "https://www.ardanlabs.com/blog/2018/08/scheduling-in-go-part2.html" },
        { title: "Jaana Dogan, Go's work-stealing scheduler", href: "https://rakyll.org/scheduler/" },
        { title: "the Tokio blog, Making the Tokio scheduler 10x faster", href: "https://tokio.rs/blog/2019-10-scheduler" },
      ]} />
    </PgFrame>
  );
}
