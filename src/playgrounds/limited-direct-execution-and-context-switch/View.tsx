"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  HOPS, REQ_COUNT, REQ_CPU, REQ_EVERY, REQ_FIRST, SWITCH, TIMERS, TRAP, WARM, WINDOW, YIELD_EVERY,
  init, step, summary, timerName, type BatchMode, type Guess, type RunResult, type Seg, type Timer,
} from "./model";

const CSS = `
.lde-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-family: var(--f-code); font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.lde-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: -1px; border: 1px solid var(--line); }
.lde-k-A { background: var(--surface-2); }
.lde-k-B { background: var(--accent); }
.lde-k-kernel { background: var(--pain); }
.lde-k-warm { background: repeating-linear-gradient(45deg, var(--pain-bg), var(--pain-bg) 2px, var(--surface) 2px, var(--surface) 4px); }
.lde-strip { position: relative; height: 34px; border: 1px solid var(--line); background: var(--bg); overflow: hidden; }
.lde-strip.zoom { height: 40px; background-image: linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 10% 100%; }
.lde-strip > span { position: absolute; top: 0; bottom: 0; }
.lde-col { position: absolute; bottom: 0; display: flex; flex-direction: column-reverse; height: 100%; }
.lde-col i { display: block; width: 100%; }
.lde-req { position: absolute; top: -1px; width: 0; height: 8px; border-left: 2px solid var(--ink); }
.lde-axis { display: flex; justify-content: space-between; font-family: var(--f-code); font-size: .6rem; color: var(--ink-2); }
.lde-cpu { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 6px; }
.lde-box { border: 1px solid var(--line); background: var(--surface); padding: 6px; font-family: var(--f-code); font-size: .7rem; }
.lde-box b { display: block; font-size: .6rem; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; margin-bottom: 2px; }
.lde-box.on { border-color: var(--accent); background: var(--hl); }
.lde-box.k { border-color: var(--pain); }
.lde-hops { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
.lde-hops li { border-left: 3px solid var(--line); padding: 2px 8px; font-size: .85rem; color: var(--ink-2); }
.lde-hops li.now { border-left-color: var(--accent); color: var(--ink); background: var(--hl); }
.lde-hops li.hw::before { content: "hardware · "; font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; }
.lde-hops li.os::before { content: "kernel · "; font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; }
.lde-runs { width: 100%; border-collapse: collapse; font-size: .82rem; }
.lde-runs th, .lde-runs td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.lde-runs th:first-child, .lde-runs td:first-child { text-align: left; }
.lde-runs th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.lde-runs td.bad { color: var(--pain); font-weight: 700; }
.lde-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.lde-sub { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.lde-fade { animation: pg-hop .3s var(--ease) both; }
@media (prefers-reduced-motion: reduce) { .lde-fade { animation: none; } }
`;

const KINDS: Seg["kind"][] = ["A", "B", "warm", "kernel"];
const KIND_LABEL: Record<Seg["kind"], string> = { A: "A: batch job", B: "B: API server", warm: "cache refill", kernel: "kernel: trap + switch" };
const ms = (us: number) => (us >= 1000 ? `${(us / 1000).toFixed(us >= 10000 ? 0 : 1)} ms` : `${us} µs`);
const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

/** Whole run, bucketed: each column shows the mix of A, B, refill and kernel time in 500 µs. */
function Overview({ r }: { r: RunResult }) {
  const N = 240, W = WINDOW / N;
  const cols = Array.from({ length: N }, () => ({ A: 0, B: 0, warm: 0, kernel: 0 }));
  for (const s of r.segs) {
    for (let b = Math.floor(s.start / W); b <= Math.min(N - 1, Math.floor((s.end - 1) / W)); b++) {
      const lo = Math.max(s.start, b * W), hi = Math.min(s.end, (b + 1) * W);
      if (hi > lo) cols[b][s.kind] += hi - lo;
    }
  }
  return (
    <div className="lde-strip" role="img" aria-label={`The whole ${WINDOW / 1000} ms run: A ran ${pct(r.aWorkUs / WINDOW)}, B ${pct(r.bWorkUs / WINDOW)}, overhead ${pct(r.overhead)}`}>
      {cols.map((c, i) => (
        <span key={i} className="lde-col" style={{ left: `${(i / N) * 100}%`, width: `${100 / N + 0.05}%` }}>
          {KINDS.map((k) => c[k] > 0 && <i key={k} className={`lde-k-${k}`} style={{ height: `${(c[k] / W) * 100}%`, minHeight: k === "kernel" ? 2 : 0 }} />)}
        </span>
      ))}
      {Array.from({ length: REQ_COUNT }, (_, k) => <span key={k} className="lde-req" style={{ left: `${((REQ_FIRST + k * REQ_EVERY) / WINDOW) * 100}%` }} />)}
    </div>
  );
}

/** A 6 ms window around the first request, every segment drawn to scale. */
function Zoom({ r }: { r: RunResult }) {
  const from = REQ_FIRST - 300, span = 6000, to = from + span;
  const segs = r.segs.filter((s) => s.end > from && s.start < to);
  return (
    <div className="lde-strip zoom" role="img" aria-label={`Zoom on ${ms(from)} to ${ms(to)}: ${segs.length} segments`}>
      {segs.map((s, i) => {
        const a = Math.max(s.start, from), b = Math.min(s.end, to);
        return <span key={i} className={`lde-k-${s.kind}`} style={{ left: `${((a - from) / span) * 100}%`, width: `max(1px, ${((b - a) / span) * 100}%)`, top: s.kind === "kernel" ? 0 : 8 }} title={`${KIND_LABEL[s.kind]} ${b - a} µs`} />;
      })}
      <span className="lde-req" style={{ left: `${(300 / span) * 100}%` }} />
    </div>
  );
}

function Trace({ hop, onNext }: { hop: number; onNext: () => void }) {
  const h = HOPS[hop];
  return (
    <div className="pg-card">
      <span className="label">One switch, hop by hop</span>
      <div className="lde-cpu" aria-live="polite">
        <div className={"lde-box" + (h.mode === "kernel" ? " k" : "")}><b>CPU mode</b>{h.mode === "kernel" ? "kernel mode" : "user mode"}</div>
        <div className={"lde-box" + (h.running === "A" ? " on" : "")}><b>Process A</b>{h.running === "A" ? (h.mode === "user" ? "running" : "trapped, regs on A's kernel stack") : "saved in its process structure"}</div>
        <div className={"lde-box" + (h.running === "B" ? " on" : "")}><b>Process B</b>{h.running === "B" ? (h.mode === "user" ? "running, caches cold" : "regs loaded, on B's kernel stack") : "ready, waiting"}</div>
      </div>
      <ol className="lde-hops">
        {HOPS.map((x, i) => <li key={i} className={x.who + (i === hop ? " now" : "")}><b>{x.title}.</b> {i === hop ? x.note : ""}</li>)}
      </ol>
      <div className="lde-row">
        <PgButton onClick={onNext}>{hop === HOPS.length - 1 ? "Start again" : "Next hop"}</PgButton>
        <span className="lde-sub">Two saves: the hardware saves user registers on the trap; the kernel saves kernel registers in switch()</span>
      </div>
    </div>
  );
}

function Runs({ runs }: { runs: RunResult[] }) {
  if (!runs.length) return null;
  return (
    <table className="lde-runs">
      <caption className="label" style={{ textAlign: "left" }}>Your runs</caption>
      <thead><tr><th>Timer</th><th>Batch job</th><th>B answered</th><th>Worst wait</th><th>Overhead</th><th>Switches</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={`${r.timer}:${r.batch}`}>
            <td>{timerName(r.timer)}</td><td>{r.batch === "loops" ? "loops" : "yields"}</td>
            <td className={r.answered < REQ_COUNT ? "bad" : ""}>{r.answered} / {REQ_COUNT}</td>
            <td className={r.worstMs === null || r.worstMs > 10 ? "bad" : ""}>{r.worstMs === null ? "never" : `${r.worstMs.toFixed(1)} ms`}</td>
            <td className={r.overhead > 0.1 ? "bad" : ""}>{pct(r.overhead)}</td>
            <td>{r.switches}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ runs }: { runs: RunResult[] }) {
  const s = summary(runs);
  if (!s) return <p className="muted" aria-live="polite">{runs.length ? "Now run a much shorter or much longer timer, and compare the rows." : ""}</p>;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>
        With a {timerName(s.short.timer)} timer, switching and cold caches took <b>{pct(s.short.overhead)}</b> of the CPU and B&apos;s slowest answer took {s.short.worstMs === null ? "forever" : `${s.short.worstMs.toFixed(1)} ms`}.
        With {timerName(s.long.timer)}, overhead fell to {pct(s.long.overhead)} but B waited up to {s.long.worstMs === null ? "forever" : `${s.long.worstMs.toFixed(1)} ms`}.
        {s.best && <> Your best interval for B was {timerName(s.best.timer)} ({s.best.worstMs!.toFixed(1)} ms).</>}
      </p>
      <p className="pg-takeaway">
        The timer is what lets the kernel take the CPU back. Its interval is a trade: long enough to pay for each switch, short enough that a waiting process does not wait long.
        {s.stuck ? " With no timer, a process that never traps keeps the CPU: B answered nothing." : " Now turn the timer off with the looping batch job."}
      </p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "slice", label: "Within a few ms" },
  { value: "finish", label: "When A finishes" },
  { value: "never", label: "Never, A keeps the CPU" },
];

export default function LimitedDirectExecutionPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const r = st.last;
  const revealed = st.runs.some((x) => x.timer === null && x.batch === "loops");

  return (
    <PgFrame title="One CPU, two processes, one timer" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        One core runs process <b>A</b>, a batch job that loops on CPU work, and process <b>B</b>, an API server. A request for B arrives every {REQ_EVERY / 1000} ms and needs {REQ_CPU / 1000} ms of CPU.
        <b> The kernel runs only when a trap brings it in: a system call, a device interrupt or the timer.</b> A trap costs {TRAP} µs, a switch {SWITCH} µs, and the incoming process then spends {WARM} µs refilling its caches.
      </p>

      <PgPredict<Guess>
        question="Turn the timer off. A never makes a system call. A request for B arrives. When is it answered?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed}
        answer="never"
        explain="The network interrupt does enter the kernel, but this kernel only marks B ready and returns to A. Nothing ever makes it switch: A never traps on its own and there is no timer to force a trap. On a cooperative system the fix is a reboot."
      />

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Timer interrupt every</span>
          <PgChoice<string> label="Timer interrupt interval" value={String(st.timer)}
            options={TIMERS.map((t) => ({ value: String(t), label: timerName(t), note: t === null ? "Cooperative: the kernel waits for a trap" : undefined }))}
            onChange={(v) => dispatch({ type: "timer", timer: (v === "null" ? null : Number(v)) as Timer })} />
          <span className="label">Batch job A</span>
          <PgChoice<BatchMode> label="Batch job behaviour" value={st.batch}
            options={[{ value: "loops", label: "Loops, never traps" }, { value: "yields", label: `Calls sched_yield() every ${YIELD_EVERY / 1000} ms` }]}
            onChange={(v) => dispatch({ type: "batch", batch: v })} />
          <div className="lde-row">
            <PgButton primary onClick={() => dispatch({ type: "run" })}>Run {WINDOW / 1000} ms</PgButton>
          </div>
          {r && (
            <dl className="pg-stats" aria-live="polite">
              <div className={r.answered < REQ_COUNT ? "bad" : ""}><dt>B answered</dt><dd>{r.answered} / {REQ_COUNT}</dd></div>
              <div className={r.worstMs === null || r.worstMs > 10 ? "bad" : ""}><dt>B&apos;s worst wait</dt><dd>{r.worstMs === null ? "never" : `${r.worstMs.toFixed(1)} ms`}</dd></div>
              <div className={r.overhead > 0.1 ? "bad" : ""}><dt>CPU spent switching</dt><dd>{pct(r.overhead)}</dd></div>
              <div><dt>A&apos;s useful work</dt><dd>{ms(r.aWorkUs)}</dd></div>
              <div><dt>Traps</dt><dd>{r.traps}</dd></div>
              <div><dt>Switches</dt><dd>{r.voluntary} voluntary · {r.involuntary} forced</dd></div>
            </dl>
          )}
        </div>
        <Trace hop={st.hop} onNext={() => dispatch({ type: "hop" })} />
      </div>

      <div className="pg-card">
        <span className="label">What the CPU did</span>
        <div className="lde-legend">{KINDS.map((k) => <span key={k}><i className={`lde-k-${k}`} />{KIND_LABEL[k]}</span>)}<span><i style={{ borderLeft: "2px solid var(--ink)", width: 0 }} />request arrives</span></div>
        {!r && <p className="pg-empty">Pick a timer interval and run. The strip shows every microsecond of the run.</p>}
        {r && (
          <div key={`${r.timer}:${r.batch}`} className={reduced ? "" : "lde-fade"} style={{ display: "grid", gap: 6 }}>
            <span className="lde-sub">Whole run, {WINDOW / 1000} ms</span>
            <Overview r={r} />
            <div className="lde-axis"><span>0</span><span>{WINDOW / 2000} ms</span><span>{WINDOW / 1000} ms</span></div>
            <span className="lde-sub">Zoom: 6 ms around the first request (kernel time drawn above)</span>
            <Zoom r={r} />
            <div className="lde-axis"><span>{ms(REQ_FIRST - 300)}</span><span>{ms(REQ_FIRST + 2700)}</span><span>{ms(REQ_FIRST + 5700)}</span></div>
          </div>
        )}
        <Runs runs={st.runs} />
        <Result runs={st.runs} />
        <p className="pg-note">A model with realistic orders of magnitude, not a benchmark. Real switch costs run from about a microsecond to tens of microseconds once caches and the TLB are counted.</p>
      </div>

      <PgSources links={[
        { title: "OSTEP, Limited Direct Execution", href: "https://pages.cs.wisc.edu/~remzi/OSTEP/cpu-mechanisms.pdf" },
        { title: "Eli Bendersky, Measuring context switching overheads", href: "https://eli.thegreenplace.net/2018/measuring-context-switching-and-memory-overheads-for-linux-threads/" },
        { title: "Li, Ding and Shen, Quantifying the cost of context switch", href: "https://www.cs.rochester.edu/~kshen/papers/expcs2007.pdf" },
      ]} />
    </PgFrame>
  );
}
