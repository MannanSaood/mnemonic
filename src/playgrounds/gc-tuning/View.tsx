"use client";
import { useMemo } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CONTAINER, LIMITS, OVERHEAD, PEAKS, STEPS, STEP_MS, init, params, simulate, step,
  type Guess, type RunRow, type Sim, type State,
} from "./model";

const VW = 600, VH = 300, X0 = 44, X1 = 590, YTOP = 12, YBOT = 226, YMAX = 640, CPU_TOP = 246, CPU_BOT = 290;
const xOf = (ms: number) => X0 + (ms / (STEPS * STEP_MS)) * (X1 - X0);
const yOf = (mib: number) => YBOT - (Math.min(mib, YMAX) / YMAX) * (YBOT - YTOP);

const CSS = `
.gu-chart { width: 100%; height: auto; display: block; border: 1px solid var(--line); background: var(--bg); }
.gu-grid { stroke: var(--grid); stroke-width: 1; }
.gu-axis { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); letter-spacing: .04em; }
.gu-live { fill: var(--surface-2); stroke: var(--ink-2); stroke-width: 1; }
.gu-total { fill: none; stroke: var(--accent); stroke-width: 1.8; }
.gu-goal { fill: none; stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 2 3; }
.gu-limit { stroke: var(--accent); stroke-width: 1.4; stroke-dasharray: 6 4; }
.gu-oomline { stroke: var(--pain); stroke-width: 1.6; }
.gu-cycle { stroke: var(--ink); stroke-width: 1; }
.gu-cpu { fill: var(--ink-2); }
.gu-cpu.hot { fill: var(--pain); }
.gu-capline { stroke: var(--pain); stroke-width: 1; stroke-dasharray: 3 3; }
.gu-lim { fill: var(--pain-bg); }
.gu-oom { fill: var(--pain); font-family: var(--f-code); font-size: 11px; font-weight: 700; letter-spacing: .06em; }
.gu-draw { stroke-dasharray: 2000; stroke-dashoffset: 2000; animation: gu-draw 1.2s var(--ease) forwards; }
@keyframes gu-draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) { .gu-draw { animation: none; stroke-dashoffset: 0; } }
.gu-wrap { position: relative; }
.gu-cover { position: absolute; inset: 0; display: grid; place-items: center; background: color-mix(in srgb, var(--bg) 82%, transparent); }
.gu-controls { display: grid; gap: 8px; }
.gu-controls > div { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.gu-sub { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.gu-range { width: min(260px, 100%); accent-color: var(--accent); }
.gu-cmd { font-family: var(--f-code); font-size: .8rem; border: 1px solid var(--line); background: var(--surface); padding: 4px 8px; overflow-x: auto; white-space: nowrap; }
.gu-key { display: flex; flex-wrap: wrap; gap: 10px; font-size: .78rem; color: var(--ink-2); }
.gu-key i { display: inline-block; width: 14px; height: 0; border-top: 2px solid; margin-right: 4px; vertical-align: middle; }
.gu-runs { width: 100%; border-collapse: collapse; font-size: .82rem; }
.gu-runs th, .gu-runs td { border: 1px solid var(--line); padding: 3px 5px; text-align: right; font-variant-numeric: tabular-nums; }
.gu-runs th:first-child, .gu-runs td:first-child { text-align: left; }
.gu-runs th { font-family: var(--f-code); font-size: .56rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.gu-runs td.bad { color: var(--pain); font-weight: 700; }
.gu-scroll { overflow-x: auto; }
`;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const gogcText = (g: number | null) => (g === null ? "off" : String(g));
const limitText = (l: number | null) => (l === null ? "none" : `${l}MiB`);

function Chart({ sim, st, reduced }: { sim: Sim; st: State; reduced: boolean }) {
  const s = sim.samples;
  const line = (f: (i: number) => number) => s.map((x, i) => `${i ? "L" : "M"}${xOf(x.t).toFixed(1)},${yOf(f(i)).toFixed(1)}`).join("");
  const livePath = `${line((i) => s[i].live + OVERHEAD)}L${xOf(s[s.length - 1].t)},${YBOT}L${X0},${YBOT}Z`;
  const goalPath = s.filter((x) => Number.isFinite(x.goal)).length === s.length ? line((i) => s[i].goal + OVERHEAD) : "";
  const buckets = Array.from({ length: Math.ceil(s.length / 10) }, (_, b) => s[Math.min(s.length - 1, b * 10 + 9)]);
  const limRuns: [number, number][] = [];
  s.forEach((x) => { if (!x.limiter) return; const last = limRuns[limRuns.length - 1]; if (last && last[1] === x.t) last[1] = x.t + STEP_MS; else limRuns.push([x.t, x.t + STEP_MS]); });
  const key = `${st.gogc}-${st.limit}-${st.peak}`;
  return (
    <svg className="gu-chart" viewBox={`0 0 ${VW} ${VH}`} role="img"
      aria-label={`Memory over 6 seconds. Peak ${Math.round(sim.peakTotal)} MiB of a ${CONTAINER} MiB container. ${sim.cycles.length} GC cycles.${sim.oomAt !== null ? ` OOM-killed at ${sec(sim.oomAt)}.` : ""}`}>
      {limRuns.map(([a, b]) => <rect key={a} className="gu-lim" x={xOf(a)} y={YTOP} width={Math.max(1, xOf(b) - xOf(a))} height={CPU_BOT - YTOP} />)}
      {[128, 256, 384].map((m) => <g key={m}><line className="gu-grid" x1={X0} x2={X1} y1={yOf(m)} y2={yOf(m)} /><text className="gu-axis" x={X0 - 4} y={yOf(m) + 3} textAnchor="end">{m}</text></g>)}
      {[0, 1, 2, 3, 4, 5, 6].map((t) => <text key={t} className="gu-axis" x={xOf(t * 1000)} y={YBOT + 11} textAnchor="middle">{t}s</text>)}
      <text className="gu-axis" x={X0 - 4} y={YTOP + 4} textAnchor="end">MiB</text>
      <path className="gu-live" d={livePath} />
      {goalPath && <path className="gu-goal" d={goalPath} />}
      <path key={key} className={"gu-total" + (reduced ? "" : " gu-draw")} d={line((i) => s[i].total)} />
      <line className="gu-oomline" x1={X0} x2={X1} y1={yOf(CONTAINER)} y2={yOf(CONTAINER)} />
      <text className="gu-axis" x={X1} y={yOf(CONTAINER) - 3} textAnchor="end" style={{ fill: "var(--pain)" }}>container limit {CONTAINER} MiB</text>
      {st.limit !== null && st.limit < YMAX && <>
        <line className="gu-limit" x1={X0} x2={X1} y1={yOf(st.limit)} y2={yOf(st.limit)} />
        <text className="gu-axis" x={X0 + 4} y={yOf(st.limit) - 3} style={{ fill: "var(--accent)" }}>GOMEMLIMIT {st.limit} MiB</text>
      </>}
      {sim.cycles.map((t) => <line key={t} className="gu-cycle" x1={xOf(t)} x2={xOf(t)} y1={YBOT + 14} y2={YBOT + 19} />)}
      <text className="gu-axis" x={X0 - 4} y={YBOT + 19} textAnchor="end">GC</text>
      <text className="gu-axis" x={X0 - 4} y={CPU_TOP + 8} textAnchor="end">GC CPU</text>
      <line className="gu-capline" x1={X0} x2={X1} y1={(CPU_TOP + CPU_BOT) / 2} y2={(CPU_TOP + CPU_BOT) / 2} />
      {buckets.map((b, i) => {
        const h = b.gcShare * (CPU_BOT - CPU_TOP);
        return <rect key={i} className={"gu-cpu" + (b.gcShare > 0.3 ? " hot" : "")} x={xOf(i * 100) + 0.5} width={Math.max(1, xOf(100) - X0 - 1)} y={CPU_BOT - h} height={h} />;
      })}
      <line className="gu-grid" x1={X0} x2={X1} y1={CPU_BOT} y2={CPU_BOT} />
      {sim.oomAt !== null && <g>
        <line className="gu-oomline" x1={xOf(sim.oomAt)} x2={xOf(sim.oomAt)} y1={YTOP} y2={YBOT} />
        <text className="gu-oom" x={Math.min(xOf(sim.oomAt) + 4, X1 - 120)} y={YTOP + 26}>OOMKilled {sec(sim.oomAt)}</text>
      </g>}
    </svg>
  );
}

function Stats({ sim }: { sim: Sim }) {
  return (
    <dl className="pg-stats">
      <div className={sim.oomAt !== null ? "bad" : ""}><dt>Outcome</dt><dd>{sim.oomAt !== null ? `killed at ${sec(sim.oomAt)}` : "survived"}</dd></div>
      <div className={sim.peakTotal > CONTAINER ? "bad" : ""}><dt>Peak memory</dt><dd>{Math.round(sim.peakTotal)} MiB</dd></div>
      <div><dt>GC cycles</dt><dd>{sim.cycles.length}</dd></div>
      <div><dt>GC CPU, average</dt><dd>{pct(sim.avgGcShare)}</dd></div>
      <div className={sim.maxGcShare > 0.3 ? "bad" : ""}><dt>GC CPU, worst second</dt><dd>{pct(sim.maxGcShare)}</dd></div>
      <div className={sim.maxGcShare > 0.3 ? "bad" : ""}><dt>Program speed, worst second</dt><dd>{pct(1 - sim.maxGcShare)}</dd></div>
      <div className={sim.limiterMs ? "bad" : ""}><dt>CPU limiter held GC</dt><dd>{sim.limiterMs} ms</dd></div>
      <div><dt>Non-heap memory</dt><dd>{OVERHEAD} MiB</dd></div>
    </dl>
  );
}

function Runs({ runs }: { runs: RunRow[] }) {
  if (!runs.length) return null;
  return (
    <div className="gu-scroll">
      <table className="gu-runs">
        <caption className="label" style={{ textAlign: "left" }}>Your runs</caption>
        <thead><tr><th>GOGC · limit · burst</th><th>Peak</th><th>Cycles</th><th>Worst GC CPU</th><th>Outcome</th></tr></thead>
        <tbody>
          {runs.map((r, i) => (
            <tr key={i}>
              <td>{gogcText(r.gogc)} · {limitText(r.limit)} · {r.peak} MiB</td>
              <td className={r.peakTotal > CONTAINER ? "bad" : ""}>{Math.round(r.peakTotal)}</td>
              <td>{r.cycles}</td>
              <td className={r.maxGcShare > 0.3 ? "bad" : ""}>{pct(r.maxGcShare)}</td>
              <td className={r.oomAt !== null ? "bad" : ""}>{r.oomAt !== null ? `OOM ${sec(r.oomAt)}` : "ok"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Result({ runs }: { runs: RunRow[] }) {
  const killed = [...runs].reverse().find((r) => r.oomAt !== null && r.limit === null);
  const saved = killed && [...runs].reverse().find((r) => r.oomAt === null && r.limit !== null && r.peak === killed.peak);
  const spiral = [...runs].reverse().find((r) => r.maxGcShare > 0.4);
  if (!killed || !saved) {
    return <p className="muted" aria-live="polite">{runs.length ? (killed ? "Now set GOMEMLIMIT a little under the container limit and run the same burst." : "Try the default settings with the 300 MiB burst, then fix it.") : ""}</p>;
  }
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>With GOGC {gogcText(killed.gogc)} and no limit, a {killed.peak} MiB live heap let memory reach the container limit and the pod was killed at <b>{sec(killed.oomAt!)}</b>.
        {" "}With GOMEMLIMIT {saved.limit} MiB the same burst peaked at <b>{Math.round(saved.peakTotal)} MiB</b>, for {saved.cycles} cycles instead of {killed.cycles} and at most {pct(saved.maxGcShare)} of CPU.
        {spiral && <> With a {spiral.peak} MiB live heap and a {limitText(spiral.limit)} limit, the GC took <b>{pct(spiral.maxGcShare)}</b> of CPU in the worst second{spiral.oomAt !== null ? `, and the pod died anyway at ${sec(spiral.oomAt)}` : ", and the program ran at about half speed"}.</>}
      </p>
      <p className="pg-takeaway">GOGC trades memory for CPU everywhere. GOMEMLIMIT makes the GC work harder only when memory is short, so set it a little under the container limit. Neither can make a live heap fit that does not: near the limit the GC eats the CPU, and above it the pod dies anyway.</p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "fits", label: "Fine: 300 MiB fits in 512" },
  { value: "oom", label: "OOM-killed during the burst" },
  { value: "slow", label: "The GC runs constantly but it survives" },
];

export default function GcTuning() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const sim = useMemo(() => simulate(params(st)), [st.gogc, st.limit, st.peak]); // eslint-disable-line react-hooks/exhaustive-deps
  const revealed = st.shown && st.runs.some((r) => r.peak === 300 && r.limit === null && r.gogc === 100);

  return (
    <PgFrame title="Heap meter" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        An ingest service runs in a container with a {CONTAINER} MiB memory limit. Its live heap is 100 MiB, and a burst of large batches raises it
        between 1.5 s and 4.5 s. It allocates 400 MiB/s. <b>Set GOGC and GOMEMLIMIT, run the burst, and watch memory, GC frequency and GC CPU.</b>
      </p>

      <PgPredict<Guess>
        question={`The live heap peaks at 300 MiB in a ${CONTAINER} MiB container. GOGC is 100, the default, and GOMEMLIMIT is not set. What happens during the burst?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed}
        answer="oom"
        explain="GOGC 100 lets the heap grow to twice the live heap before the next cycle: about 600 MiB, plus stacks and runtime memory. The GC does not know about the container limit, so the kernel kills the pod first."
      />

      <div className="gu-controls">
        <div>
          <label className="gu-sub" htmlFor="gu-gogc">GOGC {gogcText(st.gogc)}</label>
          <input id="gu-gogc" className="gu-range" type="range" min={25} max={400} step={25} value={st.gogc ?? 400} disabled={st.gogc === null}
            onChange={(e) => dispatch({ type: "gogc", value: +e.target.value })} />
          <PgButton onClick={() => dispatch({ type: "gogc", value: st.gogc === null ? 100 : null })}>{st.gogc === null ? "Turn GOGC back on" : "GOGC=off"}</PgButton>
        </div>
        <div><span className="gu-sub">GOMEMLIMIT</span>
          <PgChoice label="GOMEMLIMIT" value={String(st.limit)} options={LIMITS.map((l) => ({ value: String(l), label: l === null ? "not set" : `${l} MiB` }))}
            onChange={(v) => dispatch({ type: "limit", value: v === "null" ? null : +v })} />
        </div>
        <div><span className="gu-sub">Live heap in the burst</span>
          <PgChoice label="Live heap in the burst" value={String(st.peak)} options={PEAKS.map((p) => ({ value: String(p), label: p === 100 ? "no burst" : `${p} MiB` }))}
            onChange={(v) => dispatch({ type: "peak", value: +v })} />
        </div>
        <div className="gu-cmd" aria-label="Environment">GOGC={gogcText(st.gogc)}{st.limit !== null ? ` GOMEMLIMIT=${limitText(st.limit)}` : ""} ./ingest</div>
      </div>

      <div className="pg-card">
        <div className="gu-wrap">
          <Chart sim={sim} st={st} reduced={reduced} />
          {!st.shown && <div className="gu-cover"><PgButton primary onClick={() => dispatch({ type: "run" })}>Run the burst</PgButton></div>}
        </div>
        <div className="gu-key">
          <span><i style={{ borderColor: "var(--accent)" }} />memory in use (heap + {OVERHEAD} MiB non-heap)</span>
          <span><i style={{ borderColor: "var(--ink-2)", borderTopStyle: "dotted" }} />heap target</span>
          <span><i style={{ borderColor: "var(--ink-2)", borderTopWidth: 8 }} />live heap</span>
          <span><i style={{ borderColor: "var(--pain)" }} />container limit</span>
          <span>ticks: GC cycles · shaded: CPU limiter holding the GC back</span>
        </div>
      </div>

      {st.shown && <div className="pg-grid">
        <div className="pg-card"><Stats sim={sim} /></div>
        <div className="pg-card">
          <Runs runs={st.runs} />
          <Result runs={st.runs} />
        </div>
      </div>}
      <p className="pg-note">Model scale: 10 ms steps, GOMAXPROCS 4, a cycle costs 2 ms plus 0.5 ms of CPU per MiB of live heap. The CPU limiter here averages over 1 s; the real one uses a window of 2 × GOMAXPROCS CPU-seconds. Roots are left out of the heap target.</p>

      <PgSources links={[
        { title: "the Go GC guide and its GOGC and memory limit visualisations", href: "https://go.dev/doc/gc-guide" },
        { title: "Uber, How we saved 70K cores with GC tuning", href: "https://www.uber.com/blog/how-we-saved-70k-cores-across-30-mission-critical-services/" },
        { title: "Twitch, Go memory ballast", href: "https://blog.twitch.tv/en/2019/04/10/go-memory-ballast-how-i-learnt-to-stop-worrying-and-love-the-heap/" },
      ]} />
    </PgFrame>
  );
}
