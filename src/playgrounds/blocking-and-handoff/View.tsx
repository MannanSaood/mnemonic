"use client";
import { useEffect, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ARRIVALS_IN_BLOCK, BLOCK_AT, BLOCK_MS, END, OP_CALL, OP_NAME, PROCS, idleThreads, init, parked, queuedCount, step, threadsInSyscall,
  type Cell, type Guess, type Op, type RunResult, type State,
} from "./model";

const CSS = `
.bh-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.bh-box { border: 1px solid var(--line); background: var(--surface); padding: 6px; display: grid; gap: 4px; align-content: start; min-height: 64px; }
.bh-box.hot { border-color: var(--pain); background: var(--pain-bg); }
.bh-box.p { border-color: var(--accent); }
.bh-box.p.stuck { border-color: var(--pain); border-style: dashed; }
.bh-tag { font-family: var(--f-code); font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; }
.bh-sub { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.bh-chips { display: flex; flex-wrap: wrap; gap: 2px; }
.bh-chip { font-family: var(--f-code); font-size: .6rem; padding: 0 4px; border: 1px solid var(--ink-2); background: var(--bg); }
.bh-chip.imp { border-color: var(--pain); color: var(--pain); font-weight: 700; }
.bh-chip.m { border-color: var(--accent); color: var(--accent); }
.bh-tl { display: grid; gap: 2px; overflow-x: auto; }
.bh-lane { display: grid; grid-template-columns: 4.2em 1fr; gap: 4px; align-items: center; }
.bh-cells { display: grid; grid-template-columns: repeat(${END}, minmax(2px, 1fr)); gap: 0; height: 14px; border: 1px solid var(--line); background: var(--bg); position: relative; }
.bh-c { display: block; height: 100%; }
.bh-c.req { background: var(--accent); }
.bh-c.imp { background: var(--pain); }
.bh-c.syscall { background: repeating-linear-gradient(45deg, var(--pain) 0 2px, var(--pain-bg) 2px 4px); }
.bh-c.none { background: var(--surface-2); }
.bh-c.p1 { opacity: .6; }
.bh-mark { background: var(--ink); }
.bh-window { position: absolute; top: -1px; bottom: -1px; border-left: 1px dashed var(--ink-2); border-right: 1px dashed var(--ink-2); pointer-events: none; }
.bh-key { display: flex; flex-wrap: wrap; gap: 10px; font-size: .78rem; color: var(--ink-2); }
.bh-key i { display: inline-block; width: 12px; height: 10px; margin-right: 4px; vertical-align: middle; }
.bh-controls { display: grid; gap: 6px; }
.bh-controls > div { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.bh-events { margin: 0; padding-left: 1.1em; font-size: .85rem; color: var(--ink-2); display: grid; gap: 2px; max-height: 140px; overflow: auto; }
.bh-runs { width: 100%; border-collapse: collapse; font-size: .82rem; }
.bh-runs th, .bh-runs td { border: 1px solid var(--line); padding: 3px 5px; text-align: right; font-variant-numeric: tabular-nums; }
.bh-runs th:first-child, .bh-runs td:first-child { text-align: left; }
.bh-runs th { font-family: var(--f-code); font-size: .56rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.bh-runs td.bad { color: var(--pain); font-weight: 700; }
.bh-fresh { animation: pg-hop .3s var(--ease) both; }
@media (prefers-reduced-motion: reduce) { .bh-fresh { animation: none; } }
`;

function Board({ st, reduced }: { st: State; reduced: boolean }) {
  const inKernel = st.ms.filter((m) => m.state === "syscall");
  const net = parked(st, "netpoller"), ch = parked(st, "chan");
  const idle = st.ms.filter((m) => m.state === "idle");
  return (
    <div className="bh-board">
      {st.ps.map((p) => {
        const g = p.run !== null ? st.gs[p.run] : null;
        const stuck = p.status === "syscall";
        return (
          <div key={p.id} className={"bh-box p" + (stuck ? " stuck" : "")}>
            <span className="bh-tag">P{p.id}</span>
            <span className="bh-sub">{stuck ? `stuck with M${p.m} in a syscall` : p.m !== null ? `held by M${p.m}` : "idle, no thread"}</span>
            <div className="bh-chips">
              {g && <span key={g.id} className={"bh-chip " + g.kind + (reduced ? "" : " bh-fresh")}>running G{g.id}</span>}
              <span className="bh-chip">{p.q.length} waiting</span>
            </div>
          </div>
        );
      })}
      <div className={"bh-box" + (inKernel.length ? " hot" : "")}>
        <span className="bh-tag">Kernel</span>
        <span className="bh-sub">threads blocked in a syscall</span>
        <div className="bh-chips">{inKernel.length ? inKernel.map((m) => <span key={m.id} className="bh-chip m">M{m.id} · G{m.g}</span>) : <span className="bh-sub">none</span>}</div>
      </div>
      <div className="bh-box">
        <span className="bh-tag">Netpoller</span>
        <span className="bh-sub">goroutines waiting on sockets</span>
        <div className="bh-chips">{net.length ? net.map((g) => <span key={g.id} className="bh-chip imp">G{g.id}</span>) : <span className="bh-sub">none</span>}</div>
      </div>
      <div className="bh-box">
        <span className="bh-tag">Channel jobs</span>
        <span className="bh-sub">goroutines parked on it</span>
        <div className="bh-chips">{ch.length ? ch.map((g) => <span key={g.id} className="bh-chip imp">G{g.id}</span>) : <span className="bh-sub">none</span>}</div>
      </div>
      <div className="bh-box">
        <span className="bh-tag">Idle threads</span>
        <span className="bh-sub">Ms parked, kept for reuse</span>
        <div className="bh-chips">{idle.length ? idle.map((m) => <span key={m.id} className="bh-chip m">M{m.id}</span>) : <span className="bh-sub">none</span>}</div>
      </div>
      <div className="bh-box">
        <span className="bh-tag">Global queue</span>
        <span className="bh-sub">{st.global.length} waiting</span>
      </div>
    </div>
  );
}

function Timeline({ st }: { st: State }) {
  const lanes = st.ms.map((m) => m.id);
  const at = (t: number, m: number): Cell | undefined => st.timeline[t]?.[m];
  const left = `${(BLOCK_AT / END) * 100}%`, width = `${(BLOCK_MS / END) * 100}%`;
  return (
    <div className="bh-tl" role="img" aria-label={`Timeline of ${lanes.length} OS threads over ${END} ms. The ${BLOCK_MS} ms block starts at ${BLOCK_AT} ms.`}>
      {lanes.map((id) => (
        <div key={id} className="bh-lane">
          <span className="bh-sub">M{id}</span>
          <div className="bh-cells">
            {Array.from({ length: END }, (_, t) => {
              const c = at(t, id);
              return <i key={t} className={"bh-c" + (c ? ` ${c.what}` : "") + (c && c.p === 1 && c.what === "req" ? " p1" : "")} />;
            })}
            <span className="bh-window" style={{ left, width }} />
          </div>
        </div>
      ))}
      <div className="bh-lane">
        <span className="bh-sub">sysmon</span>
        <div className="bh-cells" style={{ height: 8 }}>
          {Array.from({ length: END }, (_, t) => <i key={t} className={"bh-c" + (st.handoffAt.includes(t) ? " bh-mark" : "")} title={st.handoffAt.includes(t) ? `hand-off at ${t} ms` : undefined} />)}
        </div>
      </div>
      <div className="bh-key">
        <span><i className="bh-c req" />running a request</span>
        <span><i className="bh-c syscall" />blocked in the kernel</span>
        <span><i className="bh-c none" />spinning, no work</span>
        <span><i className="bh-mark" />sysmon hand-off</span>
        <span>dashed: the {BLOCK_MS} ms block</span>
      </div>
    </div>
  );
}

function Stats({ st }: { st: State }) {
  const blockOver = st.t >= BLOCK_AT + BLOCK_MS;
  return (
    <dl className="pg-stats">
      <div><dt>Time</dt><dd>{st.t} ms</dd></div>
      <div><dt>Requests served</dt><dd>{st.served}</dd></div>
      <div className={blockOver && st.servedDuringBlock < ARRIVALS_IN_BLOCK ? "bad" : ""}><dt>Served in the block</dt><dd>{st.servedDuringBlock}{blockOver ? ` of ${ARRIVALS_IN_BLOCK}` : ""}</dd></div>
      <div className={st.worstWait > 5 ? "bad" : ""}><dt>Worst queue wait</dt><dd>{st.worstWait} ms</dd></div>
      <div className={st.ms.length > PROCS ? "bad" : ""}><dt>OS threads</dt><dd>{st.ms.length}</dd></div>
      <div><dt>In a syscall</dt><dd>{threadsInSyscall(st)}</dd></div>
      <div><dt>Idle threads</dt><dd>{idleThreads(st)}</dd></div>
      <div><dt>Waiting now</dt><dd>{queuedCount(st)}</dd></div>
    </dl>
  );
}

const label = (r: RunResult) => `${r.blockers > 1 ? r.blockers + "× " : ""}${OP_NAME[r.op]}${r.op === "file" && !r.sysmon ? ", no hand-off" : ""}`;

function Runs({ runs }: { runs: RunResult[] }) {
  if (!runs.length) return null;
  return (
    <table className="bh-runs">
      <caption className="label" style={{ textAlign: "left" }}>Your runs</caption>
      <thead><tr><th>Blocking call</th><th>Served in block</th><th>Worst wait</th><th>Threads</th></tr></thead>
      <tbody>
        {runs.map((r, i) => (
          <tr key={i}>
            <td>{label(r)}</td>
            <td className={r.servedDuringBlock < ARRIVALS_IN_BLOCK ? "bad" : ""}>{r.servedDuringBlock} of {ARRIVALS_IN_BLOCK}</td>
            <td className={r.worstWaitMs > 5 ? "bad" : ""}>{r.worstWaitMs} ms</td>
            <td className={r.threads > PROCS ? "bad" : ""}>{r.threads}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ runs }: { runs: RunResult[] }) {
  const find = (op: Op, sysmon: boolean) => [...runs].reverse().find((r) => r.op === op && r.sysmon === sysmon && r.blockers === 1);
  const net = find("net", true) ?? find("net", false) ?? find("chan", true) ?? find("chan", false);
  const file = find("file", true), stuck = find("file", false);
  if (!file || !(net || stuck)) {
    return <p className="muted" aria-live="polite">{runs.length ? "Now try another kind of blocking call, or turn the hand-off off, and compare the rows." : ""}</p>;
  }
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>While one goroutine blocked for {BLOCK_MS} ms:
        {net && <> a <b>{OP_NAME[net.op]}</b> kept {net.servedDuringBlock} of {ARRIVALS_IN_BLOCK} requests on time with {net.threads} threads;</>}
        {" "}a <b>file read</b> also served {file.servedDuringBlock}, worst wait {file.worstWaitMs} ms, but needed {file.threads} threads;
        {stuck && <> without the hand-off it served only {stuck.servedDuringBlock}, and a request waited {stuck.worstWaitMs} ms.</>}
      </p>
      <p className="pg-takeaway">A goroutine that parks (channel, network) gives its thread back at once. A blocking system call keeps the thread, so the runtime keeps the other goroutines running by handing the P to another thread. Throughput is protected; the price is one OS thread per blocked call.</p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "park", label: "Nothing: Go parks it" },
  { value: "stall", label: "Its P stalls for 30 ms" },
  { value: "handoff", label: "A new thread takes its P" },
];

export default function BlockingHandoff() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const done = st.recorded;
  useEffect(() => {
    if (!playing || done) { if (done) setPlaying(false); return; }
    const t = setInterval(() => dispatch({ type: "tick" }), reduced ? 40 : 110);
    return () => clearInterval(t);
  }, [playing, done, reduced, dispatch]);
  const stop = () => setPlaying(false);
  const revealed = st.runs.some((r) => r.op === "file" && r.sysmon);

  return (
    <PgFrame title="Block a goroutine, watch the thread" onReset={() => { stop(); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <p className="pg-rule">
        A thumbnail service with GOMAXPROCS {PROCS} serves a steady stream of small requests, 1.5 per ms, each 1 ms of CPU. At {BLOCK_AT} ms an
        importer goroutine makes one call that waits {BLOCK_MS} ms. <b>Pick how it waits, run it, and count how many other requests keep running.</b>
      </p>

      <PgPredict<Guess>
        question={`The importer calls f.Read on a file whose NFS mount has stalled for ${BLOCK_MS} ms. What happens to the requests queued on its P?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed}
        answer="handoff"
        explain="A file read is a blocking system call: the thread goes into the kernel with the goroutine, and the P waits with it. sysmon notices on its next look and hands the P to another thread, so requests wait about a millisecond. The cost is an extra OS thread."
      />

      <div className="bh-controls">
        <div><span className="bh-sub">The importer waits on</span>
          <PgChoice<Op> label="Blocking call" value={st.op} options={(["chan", "net", "file"] as Op[]).map((o) => ({ value: o, label: OP_NAME[o], note: OP_CALL[o] }))}
            onChange={(o) => { stop(); dispatch({ type: "op", op: o }); }} />
        </div>
        <div><span className="bh-sub">Importers</span>
          <PgChoice label="Importers" value={String(st.blockers)} options={[{ value: "1", label: "1" }, { value: "4", label: "4 at once" }]}
            onChange={(v) => { stop(); dispatch({ type: "blockers", n: +v }); }} />
          <span className="bh-sub">sysmon hand-off</span>
          <PgChoice label="sysmon hand-off" value={st.sysmon ? "on" : "off"} options={[{ value: "on", label: "on" }, { value: "off", label: "off (what if)" }]}
            onChange={(v) => { stop(); dispatch({ type: "sysmon", on: v === "on" }); }} />
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
        <Board st={st} reduced={reduced} />
        <span className="label">Each OS thread, millisecond by millisecond</span>
        <Timeline st={st} />
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <Stats st={st} />
          <ol className="bh-events" aria-live="polite">
            {st.events.slice(0, 8).map((e, i) => <li key={st.events.length - i}>{e}</li>)}
          </ol>
        </div>
        <div className="pg-card">
          <Runs runs={st.runs} />
          <Result runs={st.runs} />
          <p className="pg-note">The hand-off switch is a what-if: the real runtime cannot turn sysmon off. Model scale: 1 ms ticks, and sysmon looks every tick; the real one sleeps between 20 µs and 10 ms.</p>
        </div>
      </div>

      <PgSources links={[
        { title: "Ardan Labs, Scheduling in Go part II (syscalls and the network poller)", href: "https://www.ardanlabs.com/blog/2018/08/scheduling-in-go-part2.html" },
        { title: "Kavya Joshi, The Scheduler Saga", href: "https://www.youtube.com/watch?v=YHRO5WQGh0k" },
        { title: "the comments in runtime/proc.go", href: "https://github.com/golang/go/blob/master/src/runtime/proc.go" },
      ]} />
    </PgFrame>
  );
}
