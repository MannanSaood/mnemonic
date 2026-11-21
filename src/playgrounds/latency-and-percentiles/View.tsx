"use client";
import { useMemo } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BUCKETS, CALLS, CHALLENGES, FLEET_REQUESTS, MAX_FANOUT, PAGES, SLOW_MS, SPIKE_RATES, SPIKE_SIZES,
  analyse, bucketEdge, fmtMs, init, pct, step,
  type Fleet, type Guess, type Summary,
} from "./model";

const W = 600, PAD = 8;
const LOG_MIN = 0, LOG_MAX = 4; // 1 ms .. 10 s
const xOf = (ms: number) => PAD + ((Math.log10(Math.max(ms, 1)) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (W - 2 * PAD);

interface Marker { label: string; value: number; cls: string }

function Histogram({ s, markers, label, reduced }: { s: Summary; markers: Marker[]; label: string; reduced: boolean }) {
  const h = 128, top = 34, bottom = h - 16;
  const peak = Math.max(1, ...s.counts);
  const y = (c: number) => bottom - (Math.log10(1 + c) / Math.log10(1 + peak)) * (bottom - top);
  const bw = (W - 2 * PAD) / BUCKETS - 1;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="lat-chart" role="img" aria-label={label}>
      <rect x={xOf(SLOW_MS)} y={top - 6} width={W - PAD - xOf(SLOW_MS)} height={bottom - top + 6} className="lat-slowband" />
      <text x={xOf(SLOW_MS) + 3} y={bottom - 4} className="lat-tiny">slower than {SLOW_MS} ms</text>
      {s.counts.map((c, k) => c > 0 && (
        <rect key={k} x={xOf(bucketEdge(k)) + 0.5} y={y(c)} width={bw} height={bottom - y(c)}
          className={"lat-bar" + (bucketEdge(k) >= SLOW_MS ? " slow" : "")} style={reduced ? undefined : { transition: "y .25s, height .25s" }}>
          <title>{c} between {fmtMs(bucketEdge(k))} and {fmtMs(bucketEdge(k + 1))}</title>
        </rect>
      ))}
      {markers.map((m, i) => (
        <g key={m.label} className={m.cls}>
          <line x1={xOf(m.value)} x2={xOf(m.value)} y1={6 + (i % 2) * 12} y2={bottom} className="lat-mark" />
          <text x={xOf(m.value) + (xOf(m.value) > W - 90 ? -3 : 3)} y={14 + (i % 2) * 12} textAnchor={xOf(m.value) > W - 90 ? "end" : "start"} className="lat-mlabel">{m.label} {fmtMs(m.value)}</text>
        </g>
      ))}
      <g className="lat-axis">
        <line x1={PAD} y1={bottom} x2={W - PAD} y2={bottom} />
        {[1, 10, 100, 1000, 10000].map((t) => <text key={t} x={xOf(t)} y={h - 3} textAnchor={t === 1 ? "start" : t === 10000 ? "end" : "middle"}>{fmtMs(t)}</text>)}
      </g>
    </svg>
  );
}

function FanCurve({ rate, n, simulated }: { rate: number; n: number; simulated: number }) {
  const w = 280, h = 120, l = 30, r = 8, t = 8, b = 18;
  const x = (k: number) => l + ((k - 1) / (MAX_FANOUT - 1)) * (w - l - r);
  const y = (v: number) => t + (1 - v) * (h - t - b);
  const pts = Array.from({ length: MAX_FANOUT }, (_, i) => `${x(i + 1)},${y(1 - (1 - rate) ** (i + 1))}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="lat-chart lat-curve" role="img" aria-label={`Share of slow pages against fan-out. At ${n} calls: ${pct(simulated)}.`}>
      <g className="lat-axis">
        <line x1={l} y1={y(0)} x2={w - r} y2={y(0)} />
        <line x1={l} y1={y(0)} x2={l} y2={y(1)} />
        {[0, 0.5, 1].map((v) => <text key={v} x={l - 3} y={y(v) + 3} textAnchor="end">{v * 100}%</text>)}
        {[1, 50, 100].map((k) => <text key={k} x={x(k)} y={h - 4} textAnchor="middle">{k}</text>)}
      </g>
      <line x1={l} x2={w - r} y1={y(0.5)} y2={y(0.5)} className="lat-half" />
      <polyline points={pts} className="lat-line" />
      <circle cx={x(n)} cy={y(simulated)} r={4.5} className="lat-dot" />
    </svg>
  );
}

function FleetPanel({ f }: { f: Fleet }) {
  const maxP = Math.max(...f.servers.map((s) => s.p99), f.avgOfP99, f.trueP99);
  const bar = (v: number) => `${Math.max(2, (Math.log10(Math.max(v, 1)) / Math.log10(maxP * 1.2)) * 100)}%`;
  return (
    <div className="lat-fleet">
      {f.servers.map((s) => (
        <div key={s.name} className={"lat-row" + (s.name === "D" ? " bad" : "")}>
          <span className="lat-k">Server {s.name}{s.name === "D" ? " · degraded" : ""}</span>
          <span className="lat-track"><i style={{ width: bar(s.p99) }} /></span>
          <span className="lat-v">p99 {fmtMs(s.p99)} · {s.requests.toLocaleString("en")} req</span>
        </div>
      ))}
      <div className="lat-row sum wrong">
        <span className="lat-k">Average of the four p99s</span>
        <span className="lat-track"><i style={{ width: bar(f.avgOfP99) }} /></span>
        <span className="lat-v">{fmtMs(f.avgOfP99)}</span>
      </div>
      <div className="lat-row sum right">
        <span className="lat-k">p99 of summed buckets</span>
        <span className="lat-track"><i style={{ width: bar(f.mergedP99) }} /></span>
        <span className="lat-v">≤ {fmtMs(f.mergedP99)} (true {fmtMs(f.trueP99)})</span>
      </div>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "1", label: "About 1%" }, { value: "10", label: "About 10%" }, { value: "33", label: "About a third" }, { value: "60", label: "Over half" },
];

export default function LatencyPercentilesPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const a = useMemo(() => analyse(st), [st]);
  const c = a.call, pg = a.fan.page;
  const callMarkers: Marker[] = [
    { label: "p50", value: c.p50, cls: "m-p50" }, { label: "mean", value: c.mean, cls: "m-mean" },
    { label: "p99", value: c.p99, cls: "m-p99" }, { label: "max", value: c.max, cls: "m-max" },
  ];
  const pageMarkers: Marker[] = [
    { label: "p50", value: pg.p50, cls: "m-p50" }, { label: "mean", value: pg.mean, cls: "m-mean" },
    { label: "p99", value: pg.p99, cls: "m-p99" }, { label: "max", value: pg.max, cls: "m-max" },
  ];
  const ratio = st.spikeRate >= 0.01 ? Math.round(1 / st.spikeRate) : 1000;

  return (
    <PgFrame title="Tail lab" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        A search page calls its backend shards in parallel and <b>waits for the slowest one</b>. Each call usually takes about 10 ms,
        but now and then one stalls (a GC pause, a cache miss to disk). Shape that tail, then fan out.
      </p>

      <PgPredict<Guess>
        question="Each backend call is slow 1 time in 100. A page calls 40 backends in parallel and waits for all of them. What share of page loads are slow?"
        options={GUESSES}
        value={st.guess}
        onChange={(v) => dispatch({ type: "guess", value: v })}
        revealed={st.sawForty}
        answer="33"
        explain="About a third: 1 − 0.99⁴⁰ ≈ 33%. A page is fast only if all 40 calls are, and 0.99 multiplied by itself 40 times is 0.67. The rare tail of one server becomes the common case for the page."
      />

      <div className="pg-card">
        <span className="label">1 · One backend call · {CALLS.toLocaleString("en")} samples</span>
        <div className="lat-controls">
          <span className="lat-k">Slow calls</span>
          <PgChoice label="How often a call is slow" value={String(st.spikeRate)} onChange={(v) => dispatch({ type: "spikeRate", value: Number(v) })}
            options={SPIKE_RATES.map((r) => ({ value: String(r), label: `1 in ${Math.round(1 / r)}` }))} />
          <span className="lat-k">Stall length</span>
          <PgChoice label="How long a slow call takes" value={String(st.spikeMs)} onChange={(v) => dispatch({ type: "spikeMs", value: Number(v) })}
            options={SPIKE_SIZES.map((m) => ({ value: String(m), label: fmtMs(m) }))} />
        </div>
        <Histogram s={c} markers={callMarkers} reduced={reduced}
          label={`Call latency histogram. Mean ${fmtMs(c.mean)}, p50 ${fmtMs(c.p50)}, p99 ${fmtMs(c.p99)}, max ${fmtMs(c.max)}.`} />
        <dl className="pg-stats">
          <div><dt>p50 (median)</dt><dd>{fmtMs(c.p50)}</dd></div>
          <div className={c.mean > 1.5 * c.p50 ? "bad" : ""}><dt>Mean</dt><dd>{fmtMs(c.mean)}</dd></div>
          <div className={c.p99 > SLOW_MS ? "bad" : ""}><dt>p99</dt><dd>{fmtMs(c.p99)}</dd></div>
          <div className="bad"><dt>Max</dt><dd>{fmtMs(c.max)}</dd></div>
        </dl>
        <p className="lat-note">Bar height is the log of the count, so a handful of slow calls stays visible next to the big hump. The mean sits where no call actually landed.
          {" "}<PgButton onClick={() => dispatch({ type: "resample" })} title="Draw a fresh sample with the same settings">Draw a new sample</PgButton></p>
      </div>

      <div className="pg-card">
        <span className="label">2 · One page waits for N calls · {PAGES.toLocaleString("en")} page loads</span>
        <div className="lat-fanrow">
          <label className="lat-slider">
            <span className="lat-k">Fan-out N = <b>{st.fanout}</b></span>
            <input type="range" min={1} max={MAX_FANOUT} value={st.fanout} aria-label="Backend calls per page"
              onChange={(e) => dispatch({ type: "fanout", value: Number(e.target.value) })} />
          </label>
          <span className="lat-k">Hedge at p95</span>
          <PgChoice label="Hedged requests" value={st.hedge ? "on" : "off"} onChange={(v) => dispatch({ type: "hedge", on: v === "on" })}
            options={[{ value: "off", label: "Off" }, { value: "on", label: `On (backup after ${fmtMs(a.fan.hedgeAt)})` }]} />
        </div>
        <div className="lat-two">
          <Histogram s={pg} markers={pageMarkers} reduced={reduced}
            label={`Page latency histogram for ${st.fanout} calls. p50 ${fmtMs(pg.p50)}, p99 ${fmtMs(pg.p99)}. ${pct(pg.slow)} of pages slow.`} />
          <FanCurve rate={st.spikeRate} n={st.fanout} simulated={pg.slow} />
        </div>
        <dl className="pg-stats">
          <div className={pg.slow > 0.05 ? "bad" : ""}><dt>Slow pages</dt><dd>{pct(pg.slow)}</dd></div>
          <div><dt>1 − (1 − p)^N</dt><dd>{pct(a.fan.formula)}</dd></div>
          <div><dt>Page p50</dt><dd>{fmtMs(pg.p50)}</dd></div>
          <div className={pg.p99 > SLOW_MS ? "bad" : ""}><dt>Page p99</dt><dd>{fmtMs(pg.p99)}</dd></div>
        </dl>
        {st.hedge && <p className="lat-note">Hedging sent {pct(a.fan.extraLoad)} more calls. A backup is slow only if the second replica stalls too, so the page sees about p² instead of p.</p>}
      </div>

      <div className="pg-card">
        <span className="label">3 · Four servers, one p99 for the dashboard · {FLEET_REQUESTS.toLocaleString("en")} requests</span>
        <label className="lat-slider">
          <span className="lat-k">Traffic to degraded server D = <b>{pct(st.share)}</b></span>
          <input type="range" min={1} max={50} value={Math.round(st.share * 100)} aria-label="Share of traffic to server D"
            onChange={(e) => dispatch({ type: "share", value: Number(e.target.value) / 100 })} />
        </label>
        <FleetPanel f={a.fleet} />
        <p className="lat-note">
          Averaging p99s is {a.fleet.error.toFixed(1)}× too {a.fleet.tooHigh ? "high" : "low"} here. It ignores how many requests each server served.
          Summing bucket counts first, then reading p99, is right to within one bucket.
        </p>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="lat-ch">
          {CHALLENGES.map((ch) => {
            const ok = st.done.includes(ch.id);
            return <li key={ch.id} className={ok ? "done" : ""}>{ok ? "✓ " : ""}{ch.text}</li>;
          })}
        </ol>
      </div>

      <div className="pg-result" aria-live="polite">
        <span className="label">Your numbers</span>
        <p>
          One call in {ratio} stalls for {fmtMs(st.spikeMs)}. The mean call is {fmtMs(c.mean)} and the median {fmtMs(c.p50)}: neither shows the stall.
          A page that waits for {st.fanout} {st.fanout === 1 ? "call" : "calls"} was slow {pct(pg.slow)} of the time{st.hedge ? `, with hedging costing ${pct(a.fan.extraLoad)} more calls` : ""}.
        </p>
        <p className="pg-takeaway">
          {st.fanout === 1
            ? "Drag the fan-out. Every extra backend is another chance to hit the tail, and a page is only as fast as its slowest call."
            : pg.slow > 5 * st.spikeRate
              ? `Only ${pct(st.spikeRate)} of calls are slow, yet ${pct(pg.slow)} of pages are. For the page, the backend's p99 is the typical case. Watch the page's own percentiles, not the backends' means.`
              : "The tail is under control here. Turn hedging off, or raise the fan-out, and watch it come back."}
        </p>
      </div>

      <PgSources links={[
        { title: "Dean and Barroso, The Tail at Scale (CACM 2013)", href: "https://research.google/pubs/the-tail-at-scale/" },
        { title: "Marc Brooker, Tail Latency Might Matter More Than You Think", href: "https://brooker.co.za/blog/2021/04/19/latency.html" },
        { title: "Brendan Gregg's latency heat maps", href: "https://www.brendangregg.com/HeatMaps/latency.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.lat-chart { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.lat-slowband { fill: var(--pain-bg); }
.lat-tiny, .lat-axis text { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.lat-axis line { stroke: var(--line); }
.lat-bar { fill: var(--accent); }
.lat-bar.slow { fill: var(--pain); }
.lat-mark { stroke-width: 1.5; }
.lat-mlabel { font-family: var(--f-code); font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; }
.m-p50 .lat-mark { stroke: var(--good); } .m-p50 .lat-mlabel { fill: var(--good); }
.m-mean .lat-mark { stroke: var(--ink); stroke-dasharray: 4 3; } .m-mean .lat-mlabel { fill: var(--ink); }
.m-p99 .lat-mark { stroke: var(--pain); } .m-p99 .lat-mlabel { fill: var(--pain); }
.m-max .lat-mark { stroke: var(--ink-2); stroke-dasharray: 1 3; } .m-max .lat-mlabel { fill: var(--ink-2); }
.lat-controls { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.lat-controls .pg-choice { justify-self: start; }
.lat-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.lat-k b { color: var(--ink); font-size: .8rem; }
.lat-note { margin: 0; font-size: .88rem; color: var(--ink-2); }
.lat-note .pg-btn { margin-left: 4px; padding: 2px 8px; font-size: .8rem; }
.lat-fanrow { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
.lat-slider { display: grid; gap: 2px; min-width: min(100%, 260px); flex: 1; }
.lat-slider input { width: 100%; accent-color: var(--accent); }
.lat-two { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 8px; align-items: start; }
.lat-line { fill: none; stroke: var(--accent); stroke-width: 2; }
.lat-half { stroke: var(--line); stroke-dasharray: 3 3; }
.lat-dot { fill: var(--pain); stroke: var(--surface); stroke-width: 1.5; }
.lat-fleet { display: grid; gap: 4px; }
.lat-row { display: grid; grid-template-columns: 11em minmax(0, 1fr) 12em; gap: 8px; align-items: center; font-size: .85rem; }
.lat-row .lat-k { overflow-wrap: anywhere; }
.lat-track { height: 12px; border: 1px solid var(--line); background: var(--surface); display: block; }
.lat-track i { display: block; height: 100%; background: var(--accent); transition: width .25s; }
.lat-row.bad .lat-track i { background: var(--pain); }
.lat-row.sum { border-top: 1px solid var(--line); padding-top: 4px; }
.lat-row.sum.wrong .lat-track i { background: var(--ink-2); }
.lat-row.sum.right .lat-track i { background: var(--good); }
.lat-v { font-family: var(--f-code); font-size: .74rem; font-variant-numeric: tabular-nums; }
.lat-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.lat-ch li.done { color: var(--good); }
@media (max-width: 560px) {
  .lat-controls, .lat-two { grid-template-columns: 1fr; }
  .lat-row { grid-template-columns: 1fr; gap: 2px; }
}
@media (prefers-reduced-motion: reduce) { .lat-track i { transition: none; } }
`;
