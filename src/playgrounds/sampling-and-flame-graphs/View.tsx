"use client";
import { useMemo } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, ORDERS, PHASE, PROTECTED, RATES, at, fmtMs, frameAt, init, pct, program, revealed, step, trueShare, view,
  type Frame, type Guess, type Mode, type Seg, type View,
} from "./model";

const W = 600;
const WIN_FROM = 60, WIN_TO = 80; // a 20 ms window of the export, after the database query

function kind(seg: Seg | null): string {
  if (!seg) return "none";
  const leaf = seg.stack[seg.stack.length - 1];
  if (!seg.on) return "off";
  if (leaf === "json.decode") return "cur";
  if (leaf === "formatRow") return "fmt";
  if (leaf === "file.Write") return "aud";
  if (leaf === "metrics.flush") return "flush";
  return "other";
}

/** 20 ms of the program over time, with the profiler's ticks on top. */
function Timeline({ v, rate, mode, reduced }: { v: View; rate: number; mode: Mode; reduced: boolean }) {
  const h = 74, top = 14, bh = 30;
  const x = (t: number) => ((t - WIN_FROM) / (WIN_TO - WIN_FROM)) * W;
  const runs: { from: number; to: number; k: string }[] = [];
  for (let t = WIN_FROM; t < WIN_TO; t += 0.02) {
    const k = kind(at(v.prog, t));
    const last = runs[runs.length - 1];
    if (last && last.k === k) last.to = t + 0.02; else runs.push({ from: t, to: t + 0.02, k });
  }
  const period = 1000 / rate;
  const tickTimes: number[] = [];
  for (let t = PHASE + Math.ceil((WIN_FROM - PHASE) / period) * period; t < WIN_TO; t += period) tickTimes.push(t);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="fg-chart" role="img" aria-label={`20 ms of the export over time, with ${tickTimes.length} profiler ticks.`}>
      {runs.map((r, i) => <rect key={i} x={x(r.from)} y={top} width={Math.max(0.5, x(r.to) - x(r.from))} height={bh} className={`fg-k-${r.k}`} />)}
      {tickTimes.map((t, i) => {
        const seg = at(v.prog, t);
        const recorded = mode === "wall" || (seg?.on ?? false);
        return (
          <g key={i} className={"fg-tick" + (recorded ? "" : " miss")} style={reduced ? undefined : { animationDelay: `${i * 60}ms` }}>
            <line x1={x(t)} x2={x(t)} y1={4} y2={top + bh + 4} />
            <circle cx={x(t)} cy={6} r={3.5} />
          </g>
        );
      })}
      <g className="fg-axis">
        <text x={2} y={h - 4}>{WIN_FROM} ms</text>
        <text x={W - 2} y={h - 4} textAnchor="end">{WIN_TO} ms · time →</text>
      </g>
    </svg>
  );
}

function FlameGraph({ v, selected, onSelect }: { v: View; selected: string | null; onSelect: (p: string | null) => void }) {
  const { frames, total } = v.graph;
  const depth = Math.max(0, ...frames.map((f) => f.depth)) + 1;
  if (!total) return <p className="pg-empty">No samples yet. Take some: each one adds its stack to the graph below.</p>;
  return (
    <div className="fg-flame" style={{ height: depth * 22 }} role="group" aria-label={`Flame graph of ${total} samples`}>
      {frames.map((f) => {
        const w = f.total / total;
        const label = `${f.name}: ${f.total} of ${total} samples (${pct(w)})`;
        return (
          <button key={f.path} type="button"
            className={"fg-frame" + (f.off ? " off" : "") + (f.name === "metrics.flush" ? " flush" : "") + (selected === f.path ? " on" : "")}
            style={{ left: `${(f.x / total) * 100}%`, width: `${w * 100}%`, bottom: f.depth * 22 }}
            aria-pressed={selected === f.path} aria-label={label} title={label}
            onClick={() => onSelect(selected === f.path ? null : f.path)}>
            {w > 0.06 ? f.name : ""}
          </button>
        );
      })}
    </div>
  );
}

function Detail({ f, v, mode, onFix, fixed }: { f: Frame; v: View; mode: Mode; onFix: () => void; fixed: boolean }) {
  const share = f.total / v.graph.total;
  const truth = trueShare(v.prog, f.path, mode);
  const canFix = !PROTECTED.has(f.name) && !f.name.startsWith("[off-CPU]");
  return (
    <div className="fg-detail" aria-live="polite">
      <p><b>{f.name}</b> is in {f.total} of {v.graph.total} samples: <b>{pct(share)}</b> wide. It was on top of the stack (running its own code) in {f.self}.
        {" "}The true share of {mode === "cpu" ? "CPU time" : "wall time"} is {pct(truth)}{Math.abs(share - truth) > 0.1 ? ", so this graph is off" : ""}.</p>
      {canFix
        ? <PgButton onClick={onFix} disabled={fixed} title="Remove this function's time from the program, as if you had optimised it away">Make {f.name} free</PgButton>
        : <p className="fg-note">{PROTECTED.has(f.name) ? "This frame holds the whole request; pick something above it." : "This is the wait itself. To remove it, make the call that waits free."}</p>}
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "70", label: "About 70% faster" }, { value: "25", label: "About a quarter faster" }, { value: "0", label: "No faster" },
];

export default function FlameGraphPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const v = useMemo(() => view(st), [st]);
  const sel = frameAt(v, st.selected);
  const base = program([]);
  const allTaken = st.taken >= v.all.length;
  const last = v.taken.slice(-5).reverse();
  const topFolded = [...v.folded.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const missed = v.taken.filter((s) => !s.stack).length;

  return (
    <PgFrame title="Fold the stacks" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        An order export takes {fmtMs(base.wallMs)} for {ORDERS.toLocaleString("en")} orders. A sampling profiler interrupts it at a fixed rate and
        records the call stack. <b>Take samples, watch them fold into a flame graph, then click a frame and make it free.</b>
      </p>

      <PgPredict<Guess>
        question="The on-CPU flame graph shows currencySymbol in about 70% of the samples. If you made currencySymbol take no time at all, how much faster would the export be?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", value: g })}
        revealed={revealed(st)}
        answer="25"
        explain={`About a quarter. currencySymbol is 70% of the CPU samples, but the CPU was busy for only ${fmtMs(base.cpuMs)} of the ${fmtMs(base.wallMs)}. The rest the thread spent waiting for fsync, which an on-CPU profiler never samples. Switch to wall clock to see it.`}
      />

      <div className="fg-controls">
        <span className="fg-k">Sample rate</span>
        <PgChoice label="Sample rate" value={String(st.rate)} onChange={(r) => dispatch({ type: "rate", value: Number(r) })}
          options={RATES.map((r) => ({ value: String(r), label: `${r} Hz`, note: r === 100 ? "In step with the 10 ms metrics timer" : undefined }))} />
        <span className="fg-k">Profile</span>
        <PgChoice<Mode> label="Profile type" value={st.mode} onChange={(m) => dispatch({ type: "mode", value: m })}
          options={[{ value: "cpu", label: "On-CPU (perf, pprof)" }, { value: "wall", label: "Wall clock (on + off CPU)" }]} />
      </div>

      <div className="pg-card">
        <span className="label">1 · The program over time (20 ms of it) and the profiler&apos;s ticks</span>
        <Timeline v={v} rate={st.rate} mode={st.mode} reduced={reduced} />
        <span className="fg-legend">
          <i className="fg-k-cur" />currencySymbol <i className="fg-k-fmt" />formatRow <i className="fg-k-aud" />audit write <i className="fg-k-off" />waiting (off-CPU) <i className="fg-k-flush" />metrics.flush
          <span>● tick recorded ○ tick found the thread off-CPU</span>
        </span>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">2 · Samples</span>
          <div className="pg-actions">
            <PgButton onClick={() => dispatch({ type: "take", n: 1 })} disabled={allTaken}>Take 1</PgButton>
            <PgButton onClick={() => dispatch({ type: "take", n: 25 })} disabled={allTaken}>Take 25</PgButton>
            <PgButton primary onClick={() => dispatch({ type: "takeAll" })} disabled={allTaken}>Take all {v.all.length.toLocaleString("en")}</PgButton>
          </div>
          <p className="fg-note">{v.taken.length} of {v.all.length.toLocaleString("en")} ticks taken. {st.mode === "cpu" ? `${missed} found the thread waiting and recorded nothing.` : "Every tick records a stack, running or waiting."}</p>
          <ol className="fg-raw" aria-label="Most recent samples">
            {last.map((s, i) => <li key={v.taken.length - i} className={s.stack ? "" : "miss"}>{s.stack ? s.stack.join(";") : "(off-CPU: no sample)"}</li>)}
          </ol>
          <span className="fg-k">Folded: identical stacks counted</span>
          <ol className="fg-raw folded" aria-label="Folded stacks">
            {topFolded.map(([k, n]) => <li key={k}><span>{k}</span> <b>{n}</b></li>)}
          </ol>
        </div>
        <div className="pg-card">
          <dl className="pg-stats">
            <div className={v.prog.wallMs > 1000 ? "bad" : ""}><dt>Export takes</dt><dd>{fmtMs(v.prog.wallMs)}</dd></div>
            <div><dt>On CPU</dt><dd>{fmtMs(v.prog.cpuMs)}</dd></div>
            <div><dt>Samples</dt><dd>{v.graph.total}</dd></div>
            <div><dt>Made free</dt><dd>{st.fixes.length ? st.fixes.join(", ") : "nothing"}</dd></div>
          </dl>
          {st.history.length > 1 && (
            <table className="fg-runs">
              <caption className="label" style={{ textAlign: "left" }}>What each fix saved</caption>
              <thead><tr><th>Made free</th><th>Export</th><th>CPU</th></tr></thead>
              <tbody>
                {st.history.map((h, i) => (
                  <tr key={i}><td>{h.fixes.length ? h.fixes.join(" + ") : "nothing"}</td><td>{fmtMs(h.wallMs)}</td><td>{fmtMs(h.cpuMs)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {st.fixes.length > 0 && <PgButton onClick={() => dispatch({ type: "unfix" })}>Undo all fixes</PgButton>}
        </div>
      </div>

      <div className="pg-card">
        <span className="label">3 · Flame graph · {st.mode === "cpu" ? "on-CPU" : "wall clock"} · width = share of samples · left to right is alphabetical, not time</span>
        <FlameGraph v={v} selected={st.selected} onSelect={(p) => dispatch({ type: "select", path: p })} />
        {sel && <Detail f={sel} v={v} mode={st.mode} fixed={st.fixes.includes(sel.name)} onFix={() => dispatch({ type: "fix", name: sel.name })} />}
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="fg-ch">
          {CHALLENGES.map((ch) => {
            const ok = st.done.includes(ch.id);
            return <li key={ch.id} className={ok ? "done" : ""}>{ok ? "✓ " : ""}{ch.text}</li>;
          })}
        </ol>
      </div>

      <div className="pg-result" aria-live="polite">
        <span className="label">Your numbers</span>
        <p>
          {st.fixes.length
            ? `Making ${st.fixes.join(" and ")} free took the export from ${fmtMs(base.wallMs)} to ${fmtMs(v.prog.wallMs)} (${pct(1 - v.prog.wallMs / base.wallMs)} faster) and CPU time from ${fmtMs(base.cpuMs)} to ${fmtMs(v.prog.cpuMs)}.`
            : `The export takes ${fmtMs(base.wallMs)}, of which the CPU is busy for ${fmtMs(base.cpuMs)}. At ${st.rate} Hz the profiler ticks ${v.all.length.toLocaleString("en")} times.`}
        </p>
        <p className="pg-takeaway">
          {st.rate === 100 && v.graph.total > 0
            ? "At 100 Hz every tick lands inside the 10 ms metrics timer, so the graph shows almost nothing else. Sample at a rate that cannot line up with periodic work, such as 99 Hz."
            : st.mode === "cpu" && st.fixes.length && v.prog.wallMs > 1000
              ? "The CPU flame graph found the CPU hog, and fixing it saved CPU. The request is still slow: most of its time is waiting, and an on-CPU profiler does not sample a thread that is not running."
              : v.prog.wallMs < 500
                ? "Both the CPU hog and the hidden wait are gone. One came from an on-CPU profile, the other only from an off-CPU or wall-clock one."
                : "A wide frame is a frame that was on the stack in many samples. Look for wide frames near the top, and ask which kind of time the graph counts."}
        </p>
      </div>

      <PgSources links={[
        { title: "Brendan Gregg, Flame Graphs", href: "https://www.brendangregg.com/flamegraphs.html" },
        { title: "Brendan Gregg, Off-CPU Flame Graphs", href: "https://www.brendangregg.com/FlameGraphs/offcpuflamegraphs.html" },
        { title: "speedscope, an interactive flame graph viewer", href: "https://www.speedscope.app/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.fg-chart { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.fg-axis text { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.fg-k-cur { fill: var(--accent); background: var(--accent); }
.fg-k-fmt { fill: var(--accent); opacity: .45; background: var(--accent); }
.fg-k-aud { fill: var(--ink-2); background: var(--ink-2); }
.fg-k-off { fill: var(--hl); background: var(--hl); outline: 1px dashed var(--ink-2); outline-offset: -1px; }
.fg-k-flush { fill: var(--pain); background: var(--pain); }
.fg-k-other { fill: var(--good); background: var(--good); }
.fg-k-none { fill: transparent; }
.fg-tick line { stroke: var(--ink); stroke-width: 1.2; }
.fg-tick circle { fill: var(--ink); }
.fg-tick.miss line { stroke-dasharray: 2 2; stroke: var(--ink-2); }
.fg-tick.miss circle { fill: var(--surface); stroke: var(--ink-2); }
.fg-tick { animation: pg-hop .3s var(--ease) both; }
.fg-controls { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.fg-controls .pg-choice { justify-self: start; }
.fg-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.fg-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.fg-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 3px; vertical-align: -1px; }
.fg-note { margin: 0; font-size: .85rem; color: var(--ink-2); }
.fg-raw { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; font-family: var(--f-code); font-size: .66rem; }
.fg-raw li { overflow-wrap: anywhere; border-left: 2px solid var(--accent); padding-left: 6px; }
.fg-raw li.miss { border-left-color: var(--line); color: var(--ink-2); }
.fg-raw.folded li { display: flex; justify-content: space-between; gap: 8px; border-left-color: var(--ink-2); }
.fg-raw.folded b { font-variant-numeric: tabular-nums; }
.fg-flame { position: relative; width: 100%; background: var(--surface); border: 1px solid var(--line); overflow: hidden; }
.fg-frame { position: absolute; height: 21px; margin: 0; padding: 0 3px; border: 0; border-right: 1px solid var(--surface); background: var(--accent); color: var(--accent-ink);
  font-family: var(--f-code); font-size: .62rem; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: left .2s, width .2s; }
.fg-frame.off { background: var(--hl); color: var(--ink); outline: 1px dashed var(--ink-2); outline-offset: -1px; }
.fg-frame.flush { background: var(--pain); color: var(--surface); }
.fg-frame.on { box-shadow: inset 0 0 0 2px var(--ink); }
.fg-frame:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.fg-detail { display: grid; gap: 6px; justify-items: start; border-top: 1px solid var(--line); padding-top: 8px; }
.fg-detail p { margin: 0; font-size: .92rem; }
.fg-runs { width: 100%; border-collapse: collapse; font-size: .82rem; }
.fg-runs th, .fg-runs td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.fg-runs th:first-child, .fg-runs td:first-child { text-align: left; overflow-wrap: anywhere; }
.fg-runs th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.fg-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.fg-ch li.done { color: var(--good); }
@media (max-width: 560px) { .fg-controls { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .fg-tick { animation: none; } .fg-frame { transition: none; } }
`;
