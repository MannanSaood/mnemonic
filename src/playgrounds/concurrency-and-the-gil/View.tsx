"use client";
import { useMemo } from "react";
import { PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, CORES, FT_OVERHEAD, JOB, JOBS, MODELS, PICKLE_MS, PROBE_EVERY, PROC_START_MS, SWITCH_MS, WORKER_COUNTS, WORKLOADS, WORKLOAD_LABEL,
  init, keyOf, revealed, simulate, step,
  type Build, type Cell, type Config, type Guess, type Model, type Result, type Summary, type Workload,
} from "./model";

const CSS = `
.gil-tl { width: 100%; height: auto; background: var(--surface); border: 1px solid var(--line); }
.gil-lab { font-family: var(--f-code); font-size: 8px; fill: var(--ink-2); text-transform: uppercase; letter-spacing: .06em; }
.gil-run { fill: var(--accent); }
.gil-wait { fill: var(--pain); opacity: .85; }
.gil-io { fill: url(#gil-hatch); }
.gil-start { fill: var(--surface-2); stroke: var(--line); }
.gil-busy { fill: var(--accent); opacity: .55; }
.gil-axis { stroke: var(--line); }
.gil-hatch-line { stroke: var(--ink-2); stroke-width: 1; }
.gil-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: .78rem; color: var(--ink-2); margin: 0; padding: 0; list-style: none; }
.gil-legend i { display: inline-block; width: 12px; height: 8px; margin-right: 4px; vertical-align: middle; border: 1px solid var(--line); }
.gil-legend .run { background: var(--accent); }
.gil-legend .wait { background: var(--pain); }
.gil-legend .io { background: repeating-linear-gradient(135deg, var(--ink-2) 0 1px, transparent 1px 4px); }
.gil-legend .start { background: var(--surface-2); }
.gil-why { margin: 0; font-size: .95rem; }
.gil-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.gil-goals li { font-size: .9rem; padding-left: 1.6em; position: relative; }
.gil-goals li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.gil-goals li.met::before { content: "✓"; color: var(--good); font-weight: 700; }
.gil-table { width: 100%; border-collapse: collapse; font-size: .84rem; }
.gil-table th, .gil-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; font-variant-numeric: tabular-nums; }
.gil-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.gil-table tr.cur th, .gil-table tr.cur td { background: var(--hl); }
.gil-table td.bad { color: var(--pain); font-weight: 600; }
.gil-scroll { overflow-x: auto; }
.gil-tl.anim rect { transition: x .25s var(--ease), width .25s var(--ease); }
@media (prefers-reduced-motion: reduce) { .gil-tl rect { transition: none; } }
`;

const MODEL_LABEL: Record<Model, string> = { threads: "Threads", processes: "Processes", asyncio: "asyncio" };
const CELL_LABEL: Record<Exclude<Cell, "idle">, string> = { run: "running Python", wait: "ready, waiting", io: "waiting on the network", start: "process start-up" };

function waitName(c: Config) {
  if (c.model === "asyncio") return "waiting for the loop";
  if (c.model === "threads" && c.build === "gil") return "waiting for the GIL";
  return "waiting for a core";
}

function Timeline({ r, reduced }: { r: Result; reduced: boolean }) {
  const X0 = 58, W = 496, LANE = 10, GAP = 3, TOP = 30;
  const x = (t: number) => X0 + (t / r.makespan) * W;
  const h = TOP + r.lanes.length * (LANE + GAP) + 16;
  // busy strip: how many workers run Python, sampled into 124 columns
  const cols = 124, per = r.makespan / cols;
  const busyCols = Array.from({ length: cols }, (_, i) => {
    const a = Math.floor(i * per), b = Math.max(a + 1, Math.floor((i + 1) * per));
    const xs = r.busy.slice(a, b);
    return xs.reduce((s, v) => s + v, 0) / xs.length;
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * r.makespan));
  return (
    <svg className={"gil-tl" + (reduced ? "" : " anim")} viewBox={`0 0 560 ${h}`} role="img"
      aria-label={`Timeline of ${r.lanes.length - 1} workers over ${r.makespan} ms. Cores running Python: at most ${Math.max(...r.busy)} of ${CORES}. ${r.waitMs} ms spent ${waitName(r.config)}.`}>
      <defs>
        <pattern id="gil-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" className="gil-hatch-line" />
        </pattern>
      </defs>
      <text x="4" y="12" className="gil-lab">cores busy</text>
      {busyCols.map((v, i) => (
        <rect key={i} x={X0 + (i * W) / cols} y={22 - (v / CORES) * 16} width={W / cols + 0.3} height={(v / CORES) * 16} className="gil-busy" />
      ))}
      <line x1={X0} x2={X0 + W} y1="22.5" y2="22.5" className="gil-axis" />
      {r.lanes.map((lane, i) => {
        const y = TOP + i * (LANE + GAP);
        return (
          <g key={lane.label}>
            <text x="4" y={y + 8} className="gil-lab">{lane.label}</text>
            {lane.spans.filter((s) => s.cell !== "idle").map((s, j) => (
              <rect key={j} x={x(s.from)} y={y} width={Math.max(0.6, x(s.to) - x(s.from))} height={LANE} className={`gil-${s.cell}`} />
            ))}
          </g>
        );
      })}
      {ticks.map((t) => (
        <text key={t} x={x(t)} y={h - 3} textAnchor={t === 0 ? "start" : t === r.makespan ? "end" : "middle"} className="gil-lab">{t} ms</text>
      ))}
    </svg>
  );
}

function why(c: Config, r: Result): string {
  const cpuMs = JOB[c.workload].filter((s) => s.kind === "cpu").reduce((a, s) => a + s.ms, 0);
  if (c.model === "asyncio") {
    return c.workload === "io"
      ? `One thread. Every task spends almost all its time at await, so ${c.workers} requests wait on the network together.`
      : `One thread, and a task keeps the loop until it reaches an await. Each ${cpuMs} ms of validation stalls every other task, and the probe waited up to ${r.probeWorst} ms.`;
  }
  if (c.model === "processes") return `Each process has its own interpreter and its own GIL, so up to ${CORES} run Python at once. Start-up (${PROC_START_MS} ms each) and pickling (${PICKLE_MS} ms per job) are the price.`;
  if (c.build === "free") return `No GIL: up to ${CORES} threads run Python at once, one per core, each about ${Math.round((FT_OVERHEAD - 1) * 100)}% slower than on the standard build.`;
  if (c.workload === "io") return `A thread waiting on a socket releases the GIL, so ${c.workers} network waits overlap. The short CPU parts still take turns.`;
  if (c.workload === "cpu") return `Only the thread holding the GIL runs Python. With ${c.workers} ${c.workers === 1 ? "thread" : "threads"} the others wait, and the batch takes as long as on one.`;
  return `The network waits overlap, the validations do not: ${JOBS} × ${cpuMs} ms of Python still runs on one core at a time.`;
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "8x", label: "About 8× faster" },
  { value: "4x", label: "About 4× faster (4 cores)" },
  { value: "same", label: "About the same" },
];

function label(c: Config) {
  return `${MODEL_LABEL[c.model]}${c.model === "threads" ? (c.build === "free" ? " (free-threaded)" : " (GIL)") : ""} × ${c.workers}`;
}

function Takeaway({ runs }: { runs: Summary[] }) {
  const cpu = runs.filter((r) => r.config.workload === "cpu");
  const best = (pred: (r: Summary) => boolean) => cpu.filter(pred).sort((a, b) => a.makespan - b.makespan)[0];
  const one = cpu.find((r) => r.config.model === "threads" && r.config.build === "gil" && r.config.workers === 1);
  const thr = best((r) => r.config.model === "threads" && r.config.build === "gil" && r.config.workers > 1);
  const proc = best((r) => r.config.model === "processes");
  const aio = runs.filter((r) => r.config.model === "asyncio" && r.config.workload !== "io").sort((a, b) => b.probeWorst - a.probeWorst)[0];
  if (!one || !thr || !proc) return <p className="pg-note">Run the CPU batch on one thread, on several threads, and on processes to compare.</p>;
  return (
    <p className="pg-takeaway">
      CPU work: one thread took {one.makespan} ms and {thr.config.workers} threads took {thr.makespan} ms, because the GIL let one of them run at a time. {proc.config.workers} processes took {proc.makespan} ms, {(one.makespan / proc.makespan).toFixed(1)}× faster, using {proc.coreUse}% of the cores.
      {aio ? ` In asyncio, CPU work held the loop and the health probe waited up to ${aio.probeWorst} ms.` : ""} Threads and asyncio overlap waiting; only processes (or the free-threaded build) overlap computing.
    </p>
  );
}

export default function ConcurrencyAndTheGil() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const c = st.config;
  const r = useMemo(() => simulate(c), [c]);
  return (
    <PgFrame title="Threads, processes and asyncio on 4 cores" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        A worker handles {JOBS} events on a {CORES}-core machine, and a health probe needs 1 ms of Python every {PROBE_EVERY} ms. Pick the work and how it runs; the timeline shows every worker, millisecond by millisecond. <b>Watch the top strip: how many cores actually run Python?</b>
      </p>

      <PgPredict<Guess>
        question={`${JOBS} schema validations, 40 ms of pure-Python CPU each, on ${CORES} cores. Going from 1 thread to 8 threads makes the batch…`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed(st)}
        answer="same"
        explain={`On the standard build only the thread holding the GIL runs bytecode. A waiting thread asks for it after the ${SWITCH_MS} ms switch interval and the holder hands it over, so the threads take turns on one core: same total, plus the waiting.`}
      />

      <div className="pg-card">
        <span className="label">The work</span>
        <PgChoice<Workload> label="Workload" value={c.workload} onChange={(w) => dispatch({ type: "workload", workload: w })}
          options={WORKLOADS.map((w) => ({ value: w, label: WORKLOAD_LABEL[w], note: JOB[w].map((s) => `${s.kind} ${s.ms} ms`).join(", ") }))} />
        <p className="pg-note">One job: {JOB[c.workload].map((s) => `${s.ms} ms ${s.kind === "cpu" ? "of Python" : "waiting on the network"}`).join(", then ")}.</p>
        <span className="label">How it runs</span>
        <PgChoice<Model> label="Concurrency model" value={c.model} onChange={(m) => dispatch({ type: "model", model: m })}
          options={MODELS.map((m) => ({ value: m, label: MODEL_LABEL[m] }))} />
        <PgChoice<"1" | "2" | "4" | "8" | "16"> label={c.model === "asyncio" ? "Tasks at once" : "Workers"} value={String(c.workers) as "1"}
          onChange={(w) => dispatch({ type: "workers", workers: Number(w) })}
          options={WORKER_COUNTS.map((n) => ({ value: String(n) as "1", label: `${n} ${c.model === "asyncio" ? (n === 1 ? "task" : "tasks") : c.model === "processes" ? (n === 1 ? "process" : "processes") : (n === 1 ? "thread" : "threads")}` }))} />
        <PgChoice<Build> label="CPython build" value={c.build} onChange={(b) => dispatch({ type: "build", build: b })}
          disabledOptions={c.model === "threads" ? [] : ["free"]}
          options={[{ value: "gil", label: "Standard (GIL)" }, { value: "free", label: "Free-threaded (3.13+)", note: "Experimental in 3.13, supported but optional since 3.14" }]} />
        {c.model !== "threads" && c.build === "free" && <p className="pg-note">The build only changes threads. Processes each have their own GIL anyway, and asyncio is one thread.</p>}
      </div>

      <div className="pg-card">
        <span className="label">{label(c)} · {WORKLOAD_LABEL[c.workload]}</span>
        <Timeline r={r} reduced={reduced} />
        <ul className="gil-legend" aria-hidden="true">
          {(Object.keys(CELL_LABEL) as (keyof typeof CELL_LABEL)[]).map((k) => <li key={k}><i className={k} />{k === "wait" ? waitName(c) : CELL_LABEL[k]}</li>)}
        </ul>
        <p className="gil-why" aria-live="polite">{why(c, r)}</p>
        <dl className="pg-stats">
          <div><dt>Batch time</dt><dd>{r.makespan} ms</dd></div>
          <div><dt>Throughput</dt><dd>{r.throughput}/s</dd></div>
          <div className={r.coreUse <= 30 && c.workload !== "io" ? "bad" : ""}><dt>Cores used</dt><dd>{r.coreUse}%</dd></div>
          <div className={r.waitMs > r.makespan ? "bad" : ""}><dt>Time {waitName(c)}</dt><dd>{r.waitMs} ms</dd></div>
          <div className={r.probeWorst > 30 ? "bad" : ""}><dt>Worst probe wait</dt><dd>{r.probeWorst} ms</dd></div>
        </dl>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Challenges</span>
          <ul className="gil-goals">
            {CHALLENGES.map((ch) => <li key={ch.id} className={ch.met(st.runs) ? "met" : ""}>{ch.text}</li>)}
          </ul>
          <p className="pg-note">Model assumptions: the {SWITCH_MS} ms switch interval is CPython&apos;s default; process start-up ({PROC_START_MS} ms), pickling ({PICKLE_MS} ms a job) and the free-threaded overhead ({Math.round((FT_OVERHEAD - 1) * 100)}%) are round numbers. Real ones depend on the machine, the start method and the payload.</p>
        </div>
        <div className="pg-card">
          <span className="label">Your runs</span>
          <div className="gil-scroll">
            <table className="gil-table">
              <thead><tr><th>Work</th><th>How</th><th>Time</th><th>Cores</th><th>Probe</th></tr></thead>
              <tbody>
                {st.runs.slice(-8).map((run) => (
                  <tr key={run.key} className={run.key === keyOf(c) ? "cur" : ""}>
                    <th scope="row">{run.config.workload}</th>
                    <td>{label(run.config)}</td>
                    <td>{run.makespan} ms</td>
                    <td className={run.coreUse <= 30 && run.config.workload !== "io" ? "bad" : ""}>{run.coreUse}%</td>
                    <td className={run.probeWorst > 30 ? "bad" : ""}>{run.probeWorst} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="pg-result" aria-live="polite">
        <span className="label">What your runs showed</span>
        <Takeaway runs={st.runs} />
      </div>

      <PgSources links={[
        { title: "David Beazley's Understanding the Python GIL", href: "https://www.dabeaz.com/GIL/" },
        { title: "Victor Skvortsov's Python behind the scenes: the GIL", href: "https://tenthousandmeters.com/blog/python-behind-the-scenes-13-the-gil-and-its-effects-on-python-multithreading/" },
        { title: "the Python free-threading HOWTO", href: "https://docs.python.org/3/howto/free-threading-python.html" },
      ]} />
    </PgFrame>
  );
}

