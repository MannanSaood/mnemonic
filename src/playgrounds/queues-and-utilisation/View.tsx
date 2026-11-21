"use client";
import { PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BURST, CHALLENGES, JOBS, LIMIT, MAX_RATE, MIN_RATE, PER_WORKER, SERIES, SERVER_OPTIONS, SERVICE_MS,
  current, fmtMs, init, revealed, step, theoryWait,
  type Guess, type Result, type State, type Variability,
} from "./model";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const W = 600;

/** Mean wait against utilisation: the hockey stick, with the reader's runs as dots. */
function Curve({ st }: { st: State }) {
  const h = 210, l = 44, r = 10, t = 12, b = 24;
  const YMAX = 400;
  const x = (u: number) => l + Math.min(u, 1.06) / 1.06 * (W - l - r);
  const y = (ms: number) => t + (1 - Math.min(ms, YMAX) / YMAX) * (h - t - b);
  const cfg = current(st).config;
  const line = (servers: number, v: Variability) => {
    const pts: string[] = [];
    for (let u = 0.01; u < 0.995; u += 0.005) {
      const w = theoryWait(u * servers * PER_WORKER, servers, v);
      if (w === null || w > YMAX * 1.2) break;
      pts.push(`${x(u)},${y(w)}`);
    }
    return pts.join(" ");
  };
  const cur = current(st);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="que-chart" role="img"
      aria-label={`Mean wait against utilisation. Your run: ${pct(cur.rho)} offered load, mean wait ${fmtMs(cur.meanWait)}.`}>
      <rect x={x(1)} y={t} width={x(1.06) - x(1)} height={h - t - b} className="que-over" />
      <text x={x(1) + 3} y={t + 10} className="que-tiny">never drains</text>
      <g className="que-axis">
        <line x1={l} y1={y(0)} x2={W - r} y2={y(0)} />
        <line x1={l} y1={y(0)} x2={l} y2={t} />
        {[0, 0.25, 0.5, 0.75, 1].map((u) => <text key={u} x={x(u)} y={h - 8} textAnchor="middle">{pct(u)}</text>)}
        {[0, 100, 200, 300, 400].map((ms) => <text key={ms} x={l - 4} y={y(ms) + 3} textAnchor="end">{ms} ms</text>)}
        <text x={W - r} y={h - 8} textAnchor="end" className="que-tiny">busy →</text>
      </g>
      {SERVER_OPTIONS.map((c) => (
        <polyline key={c} points={line(c, cfg.variability)} className={"que-line" + (c === cfg.servers ? " on" : "")} />
      ))}
      {SERVER_OPTIONS.map((c) => {
        const u = 0.93, w = theoryWait(u * c * PER_WORKER, c, cfg.variability);
        return w !== null && w < YMAX ? <text key={c} x={x(u) - 4} y={y(w) - 2} textAnchor="end" className={"que-tiny" + (c === cfg.servers ? " on" : "")}>{c} worker{c > 1 ? "s" : ""}</text> : null;
      })}
      {st.runs.slice(1).map((run, i) => (
        <circle key={i} cx={x(run.rho)} cy={y(run.meanWait)} r={3} className="que-old" />
      ))}
      <circle cx={x(cur.rho)} cy={y(cur.meanWait)} r={6} className="que-dot" />
      {cur.meanWait > YMAX && <text x={x(Math.min(cur.rho, 1.03))} y={t + 22} textAnchor="middle" className="que-tiny bad">↑ {fmtMs(cur.meanWait)}</text>}
    </svg>
  );
}

function QueueStrip({ run }: { run: Result }) {
  const h = 80, t = 6, b = 14;
  const max = Math.max(10, ...run.series);
  const x = (i: number) => (i / (SERIES - 1)) * W;
  const y = (q: number) => t + (1 - q / max) * (h - t - b);
  const pts = run.series.map((q, i) => `${x(i)},${y(q)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="que-chart" role="img" aria-label={`Jobs waiting over the run. Longest queue ${run.maxQueue}.`}>
      {run.config.bounded && <line x1={0} x2={W} y1={y(LIMIT)} y2={y(LIMIT)} className="que-limit" />}
      <polygon points={`0,${y(0)} ${pts} ${W},${y(0)}`} className="que-area" />
      <g className="que-axis">
        <text x={2} y={t + 8}>{max} waiting</text>
        <text x={2} y={h - 3}>0 s</text>
        <text x={W - 2} y={h - 3} textAnchor="end">{Math.round(run.durationS)} s · {JOBS.toLocaleString("en")} jobs</text>
      </g>
    </svg>
  );
}

function Snapshot({ run }: { run: Result }) {
  const shown = Math.min(run.snapshot.waiting, 48);
  return (
    <div className="que-snap" aria-label={`At the end: ${run.snapshot.busy} of ${run.config.servers} workers busy, ${run.snapshot.waiting} waiting.`}>
      <div className="que-line-up" aria-hidden="true">
        {Array.from({ length: shown }, (_, i) => <i key={i} />)}
        {run.snapshot.waiting > shown && <span className="que-tiny">+{run.snapshot.waiting - shown}</span>}
        {run.snapshot.waiting === 0 && <span className="que-tiny">no one waiting</span>}
      </div>
      <span className="que-arrow" aria-hidden="true">→</span>
      <div className="que-workers" aria-hidden="true">
        {Array.from({ length: run.config.servers }, (_, i) => <b key={i} className={i < run.snapshot.busy ? "busy" : ""}>W{i + 1}</b>)}
      </div>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "18", label: "About 18 ms" }, { value: "20", label: "About 20 ms" }, { value: "90", label: "About 90 ms" }, { value: "1000", label: "Over a second" },
];

export default function QueuesPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const run = current(st), c = run.config;
  const overloaded = run.rho >= 1;
  const base = st.runs.find((r) => r.config.servers === 1 && r.config.rate === 50 && r.config.variability === "random" && !r.config.bounded && !r.config.burst);

  return (
    <PgFrame title="Checkout queue" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        Checkout jobs arrive at random and wait in a queue for a worker. Each job takes <b>{SERVICE_MS} ms on average</b>, so one worker
        can do {PER_WORKER} a second. Move the arrival rate and watch the dot on the curve.
      </p>

      <PgPredict<Guess>
        question={`One worker, ${SERVICE_MS} ms per job, is busy 50% of the time, and jobs wait about 10 ms in the queue. Traffic grows until it is busy 90% of the time. How long do jobs wait now?`}
        options={GUESSES}
        value={st.guess}
        onChange={(v) => dispatch({ type: "guess", value: v })}
        revealed={revealed(st)}
        answer="90"
        explain="About 90 ms, nine times longer for 1.8 times the traffic. With random arrivals the mean wait is the service time × ρ / (1 − ρ): 10 × 0.5 / 0.5 = 10 ms at 50%, 10 × 0.9 / 0.1 = 90 ms at 90%. The last 10% of capacity is where all the waiting happens."
      />

      <div className="pg-card">
        <span className="label">The queue</span>
        <label className="que-slider">
          <span className="que-k">Arrivals = <b>{c.rate} jobs/s</b> · offered load <b className={run.rho >= 0.9 ? "bad" : ""}>{pct(run.rho)}</b></span>
          <input type="range" min={MIN_RATE} max={MAX_RATE} value={c.rate} aria-label="Arrival rate, jobs per second"
            onChange={(e) => dispatch({ type: "rate", value: Number(e.target.value) })} />
        </label>
        <div className="que-controls">
          <span className="que-k">Workers</span>
          <PgChoice label="Workers" value={String(c.servers)} onChange={(v) => dispatch({ type: "servers", value: Number(v) })}
            options={SERVER_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))} />
          <span className="que-k">Job times</span>
          <PgChoice<Variability> label="Job times" value={c.variability} onChange={(v) => dispatch({ type: "variability", value: v })}
            options={[{ value: "random", label: "Vary (exponential)" }, { value: "constant", label: `Always ${SERVICE_MS} ms` }]} />
          <span className="que-k">Queue</span>
          <PgChoice label="Queue bound" value={c.bounded ? "on" : "off"} onChange={(v) => dispatch({ type: "bounded", on: v === "on" })}
            options={[{ value: "off", label: "Unbounded" }, { value: "on", label: `Reject past ${LIMIT}` }]} />
          <span className="que-k bad">Break it</span>
          <PgChoice label="Burst" value={c.burst ? "on" : "off"} onChange={(v) => dispatch({ type: "burst", on: v === "on" })}
            options={[{ value: "off", label: "Steady arrivals" }, { value: "on", label: `${BURST} jobs at once` }]} />
        </div>
        <Curve st={st} />
        <span className="que-legend"><i className="que-key-dot" />this run <i className="que-key-old" />earlier runs <i className="que-key-line" />theory for {c.servers} worker{c.servers > 1 ? "s" : ""}</span>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Jobs waiting over the run</span>
          <QueueStrip run={run} />
          <Snapshot run={run} />
        </div>
        <div className="pg-card">
          <dl className="pg-stats">
            <div className={run.util >= 0.9 ? "bad" : ""}><dt>Busy</dt><dd>{pct(run.util)}</dd></div>
            <div className={run.meanWait > 5 * SERVICE_MS ? "bad" : ""}><dt>Mean wait</dt><dd>{fmtMs(run.meanWait)}</dd></div>
            <div><dt>Theory</dt><dd>{run.theoryWait === null ? "∞" : fmtMs(run.theoryWait)}</dd></div>
            <div className={run.p99Wait > 20 * SERVICE_MS ? "bad" : ""}><dt>p99 wait</dt><dd>{fmtMs(run.p99Wait)}</dd></div>
            <div><dt>In system (L)</dt><dd>{run.inSystem.toFixed(1)}</dd></div>
            <div><dt>λ × W</dt><dd>{run.littleLW.toFixed(1)}</dd></div>
            <div className={run.maxQueue >= 30 ? "bad" : ""}><dt>Longest queue</dt><dd>{run.maxQueue}</dd></div>
            <div className={run.rejected ? "bad" : ""}><dt>Rejected</dt><dd>{run.rejected}</dd></div>
          </dl>
          <p className="que-note">L is measured by watching the system; λ × W multiplies the arrival rate by each job&apos;s mean time inside. They match: that is Little&apos;s law, and it holds for any queue that is not growing forever.</p>
        </div>
      </div>

      {st.runs.length > 1 && (
        <div className="pg-card">
          <span className="label">Your runs</span>
          <table className="que-runs">
            <thead><tr><th>Jobs/s</th><th>Workers</th><th>Busy</th><th>Mean wait</th><th>p99 wait</th></tr></thead>
            <tbody>
              {st.runs.slice(0, 6).map((r, i) => (
                <tr key={i} className={i === 0 ? "on" : ""}>
                  <td>{r.config.rate}{r.config.burst ? " + burst" : ""}{r.config.variability === "constant" ? " · const" : ""}{r.config.bounded ? " · bounded" : ""}</td>
                  <td>{r.config.servers}</td><td>{pct(r.util)}</td>
                  <td className={r.meanWait > 5 * SERVICE_MS ? "bad" : ""}>{fmtMs(r.meanWait)}</td><td>{fmtMs(r.p99Wait)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="que-ch">
          {CHALLENGES.map((ch) => {
            const ok = st.done.includes(ch.id);
            return <li key={ch.id} className={ok ? "done" : ""}>{ok ? "✓ " : ""}{ch.text}</li>;
          })}
        </ol>
      </div>

      <div className="pg-result" aria-live="polite">
        <span className="label">Your numbers</span>
        <p>
          {c.rate} jobs a second on {c.servers} worker{c.servers > 1 ? "s" : ""}: busy {pct(run.util)}, mean wait {fmtMs(run.meanWait)}, p99 wait {fmtMs(run.p99Wait)}
          {base && run !== base ? `. At 50 jobs a second on one worker it was ${fmtMs(base.meanWait)}.` : "."}
          {run.rejected ? ` ${run.rejected} jobs were rejected at the door.` : ""}
        </p>
        <p className="pg-takeaway">
          {overloaded && !c.bounded
            ? `Arrivals exceed capacity, so the queue grows for as long as the overload lasts: ${run.endQueue} jobs were still waiting at the end. No amount of waiting fixes it; only more capacity, less work, or rejecting jobs does.`
            : overloaded
              ? `The bound keeps the wait finite by turning ${run.rejected} jobs away. That is a choice: a fast "no" instead of a slow "yes" that times out anyway.`
              : run.rho >= 0.85
                ? `At ${pct(run.rho)} busy the workers still have ${pct(1 - run.rho)} spare, yet jobs wait ${(run.meanWait / SERVICE_MS).toFixed(0)}× longer than the work itself. Utilisation near 100% buys throughput with latency.`
                : c.burst && run.maxQueue >= 20
                  ? `The average load is low, yet ${run.maxQueue} jobs queued at once. A one-minute average hides a one-second burst.`
                  : "On the flat part of the curve, waiting is a small fraction of the work. Push the arrival rate toward the workers' capacity and watch where the curve turns."}
        </p>
      </div>

      <PgSources links={[
        { title: "Erik Bernhardsson, Waiting time, load factor, and queueing theory", href: "https://erikbern.com/2018/03/27/waiting-time-load-factor-and-queueing-theory" },
        { title: "John D. Cook, What happens when you add a new teller?", href: "https://www.johndcook.com/blog/2008/10/21/what-happens-when-you-add-a-new-teller/" },
        { title: "Marc Brooker, Telling Stories About Little's Law", href: "https://brooker.co.za/blog/2018/06/20/littles-law.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.que-chart { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.que-axis text, .que-tiny { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.que-tiny.on { fill: var(--accent); }
.que-tiny.bad { fill: var(--pain); }
.que-axis line { stroke: var(--line); }
.que-over { fill: var(--pain-bg); }
.que-line { fill: none; stroke: var(--line); stroke-width: 1.5; }
.que-line.on { stroke: var(--accent); stroke-width: 2.5; }
.que-old { fill: var(--ink-2); opacity: .5; }
.que-dot { fill: var(--pain); stroke: var(--surface); stroke-width: 2; transition: cx .2s, cy .2s; }
.que-area { fill: var(--accent); opacity: .7; }
.que-limit { stroke: var(--pain); stroke-dasharray: 4 3; }
.que-slider { display: grid; gap: 2px; }
.que-slider input { width: 100%; accent-color: var(--accent); }
.que-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.que-k b { color: var(--ink); font-size: .8rem; }
.que-k b.bad, .que-k.bad { color: var(--pain); }
.que-controls { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.que-controls .pg-choice { justify-self: start; }
.que-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; font-family: var(--f-code); font-size: .62rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.que-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 3px; vertical-align: -1px; }
.que-key-dot { background: var(--pain); border-radius: 50%; }
.que-key-old { background: var(--ink-2); opacity: .5; border-radius: 50%; }
.que-key-line { border-top: 2px solid var(--accent); height: 0 !important; }
.que-snap { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center; }
.que-line-up { display: flex; flex-wrap: wrap-reverse; flex-direction: row-reverse; gap: 2px; min-height: 18px; align-items: center; }
.que-line-up i { width: 9px; height: 9px; background: var(--pain); display: block; }
.que-arrow { color: var(--ink-2); }
.que-workers { display: flex; gap: 4px; }
.que-workers b { font-family: var(--f-code); font-size: .62rem; border: 1px solid var(--ink-2); padding: 4px 6px; font-weight: 600; background: var(--surface); }
.que-workers b.busy { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.que-note { margin: 0; font-size: .85rem; color: var(--ink-2); }
.que-runs { width: 100%; border-collapse: collapse; font-size: .85rem; }
.que-runs th, .que-runs td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.que-runs th:first-child, .que-runs td:first-child { text-align: left; }
.que-runs th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.que-runs tr.on td { background: var(--hl); }
.que-runs td.bad { color: var(--pain); font-weight: 700; }
.que-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.que-ch li.done { color: var(--good); }
@media (max-width: 560px) { .que-controls { grid-template-columns: 1fr; } .que-runs { font-size: .72rem; } }
@media (prefers-reduced-motion: reduce) { .que-dot { transition: none; } }
`;
