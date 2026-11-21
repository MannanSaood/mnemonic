"use client";
import { useEffect, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  BASE_RTT_MS, BUFFERS, BUFFER_NAME, IW, RATES, RTO_ROUNDS,
  bufferPackets, capacity, goals, init, maxQueueMs, shareA, step, utilization,
  type Buffer, type Goals, type Rate, type Sample, type State,
} from "./model";

const WINDOW = 90; // rounds shown on the chart
const pct = (x: number) => `${Math.round(x * 100)}%`;
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

/* ---------------- cwnd over time ---------------- */

function Chart({ st }: { st: State }) {
  const W = 600, H = 230, L = 36, R = 8, T = 10, Bm = 22;
  const h = st.history.slice(-WINDOW);
  const t0 = h.length ? h[0].t : 1;
  const limitNow = capacity(st.rate) + bufferPackets(st.rate, st.buffer);
  const yMax = Math.max(limitNow, ...h.map((s) => s.limit)) * 1.35;
  const x = (t: number) => L + ((t - t0) / (WINDOW - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - Math.min(v, yMax) / yMax) * (H - T - Bm);
  const line = (pick: (s: Sample) => number | null) => {
    let d = "", pen = false;
    for (const s of h) {
      const v = pick(s);
      if (v === null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${x(s.t).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
    return d;
  };
  const stepLine = (pick: (s: Sample) => number | null) => {
    let d = "", pen = false, last = 0;
    for (const s of h) {
      const v = pick(s);
      if (v === null) { pen = false; continue; }
      d += pen ? `L${x(s.t).toFixed(1)},${y(last).toFixed(1)} L${x(s.t).toFixed(1)},${y(v).toFixed(1)} ` : `M${x(s.t).toFixed(1)},${y(v).toFixed(1)} `;
      last = v; pen = true;
    }
    return d;
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => Math.round(k * yMax));
  return (
    <svg className="cc-chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Congestion window over the last ${h.length} round trips. Flow A is at ${st.flows.A.cwnd} packets; the link holds ${capacity(st.rate)} per round trip.`}>
      {ticks.map((v) => (
        <g key={v}>
          <line className="cc-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text className="cc-axis" x={L - 4} y={y(v) + 3} textAnchor="end">{v}</text>
        </g>
      ))}
      <text className="cc-axis" x={L} y={H - 6}>RTT {t0}</text>
      <text className="cc-axis" x={W - R} y={H - 6} textAnchor="end">RTT {t0 + WINDOW - 1} · packets in flight per RTT</text>
      {h.length > 0 && (
        <>
          <path className="cc-cap" d={stepLine((s) => s.capacity)} />
          <path className="cc-limit" d={stepLine((s) => s.limit)} />
          <text className="cc-axis cc-cap-l" x={W - R - 2} y={y(h[h.length - 1].capacity) + 11} textAnchor="end">link full (BDP)</text>
          <text className="cc-axis cc-limit-l" x={W - R - 2} y={y(h[h.length - 1].limit) - 4} textAnchor="end">queue full: drops</text>
          <path className="cc-ss" d={stepLine((s) => s.ssthresh.A)} />
          <path className="cc-a" d={line((s) => s.cwnd.A)} />
          <path className="cc-b" d={line((s) => s.cwnd.B)} />
          {h.flatMap((s) => s.marks.map((m, i) => {
            const v = s.cwnd[m.flow] ?? 0;
            const cx = x(s.t), cy = y(v);
            if (m.kind === "ss-exit") return null;
            return m.kind === "fast"
              ? <path key={`${s.t}-${i}`} className={"cc-mark " + (m.flow === "A" ? "a" : "b")} d={`M${cx - 4},${cy - 8} L${cx + 4},${cy - 8} L${cx},${cy - 2} z`} />
              : <path key={`${s.t}-${i}`} className="cc-mark to" d={`M${cx - 4},${cy - 12} L${cx + 4},${cy - 4} M${cx + 4},${cy - 12} L${cx - 4},${cy - 4}`} />;
          }))}
        </>
      )}
      {!h.length && <text className="cc-axis" x={W / 2} y={H / 2} textAnchor="middle">Press +1 RTT or Play to start flow A.</text>}
    </svg>
  );
}

/* ---------------- the two-flow phase plot (Chiu and Jain) ---------------- */

function Phase({ st }: { st: State }) {
  const pts = st.history.filter((s) => s.cwnd.B !== null && s.t > st.flows.B.joinedAt).slice(-160);
  const S = 200, P = 26;
  const limit = capacity(st.rate) + bufferPackets(st.rate, st.buffer);
  const max = limit * 1.1;
  const sx = (v: number) => P + (Math.min(v, max) / max) * (S - P - 6);
  const sy = (v: number) => S - P - (Math.min(v, max) / max) * (S - P - 6);
  const C = capacity(st.rate);
  const d = pts.map((s, i) => `${i ? "L" : "M"}${sx(s.cwnd.A ?? 0).toFixed(1)},${sy(s.cwnd.B ?? 0).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg className="cc-phase" viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Flow A's window against flow B's window. The fair line is the diagonal.">
      <line className="cc-grid" x1={P} y1={S - P} x2={S - 6} y2={S - P} />
      <line className="cc-grid" x1={P} y1={S - P} x2={P} y2={6} />
      <line className="cc-fair" x1={sx(0)} y1={sy(0)} x2={sx(max)} y2={sy(max)} />
      <line className="cc-cap" x1={sx(C)} y1={sy(0)} x2={sx(0)} y2={sy(C)} />
      <line className="cc-limit" x1={sx(limit)} y1={sy(0)} x2={sx(0)} y2={sy(limit)} />
      <text className="cc-axis" x={S - 8} y={S - 10} textAnchor="end">cwnd A →</text>
      <text className="cc-axis" x={10} y={14}>↑ cwnd B</text>
      <text className="cc-axis cc-fair-l" x={sx(max * 0.72)} y={sy(max * 0.8)} textAnchor="end">fair</text>
      {d && <path className="cc-traj" d={d} />}
      {last && <circle className="cc-dot" cx={sx(last.cwnd.A ?? 0)} cy={sy(last.cwnd.B ?? 0)} r={4} />}
    </svg>
  );
}

/* ---------------- the reader's own result ---------------- */

function Result({ st }: { st: State }) {
  const u = utilization(st), q = maxQueueMs(st), s = shareA(st);
  const A = st.flows.A;
  const lines: string[] = [];
  if (st.responseAt !== null)
    lines.push(`A 200 KB response needed ${n(st.responseAt, "round trip")} on this ${st.rate} Mbit/s link, because the window started at ${IW} packets and had to grow.`);
  if (A.fastRecoveries + A.timeouts > 0)
    lines.push(`Over the last ${Math.min(60, st.history.length)} RTTs the link was ${pct(u)} busy and the queue added up to ${Math.round(q)} ms of delay with a ${BUFFER_NAME[st.buffer]} buffer. The sender learned the capacity only by overflowing it: ${n(A.fastRecoveries, "halving")}${A.timeouts ? ` and ${n(A.timeouts, "timeout")}` : ""} so far.`);
  if (s !== null)
    lines.push(`Flow B joined at RTT ${st.flows.B.joinedAt}. Over the last 40 RTTs A carried ${pct(s)} and B ${pct(1 - s)}. Each loss halves the gap between them; each RTT of growth leaves it alone.`);
  if (st.udp)
    lines.push("The UDP sender never backs off, so the TCP flows give way to it at every loss. Congestion control only works when everyone runs it.");
  if (!lines.length) return null;
  return <p className="pg-takeaway">{lines.join(" ")}</p>;
}

/* ---------------- the playground ---------------- */

type G1 = "2" | "30" | "rwnd";
type G2 = "10" | "30" | "50";

export default function CongestionControl() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const [g1, setG1] = useState<G1 | null>(null);
  const [g2, setG2] = useState<G2 | null>(null);
  const [seen, setSeen] = useState<Goals>({ found: false, full: false, fair: false, timeout: false });

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => dispatch({ type: "tick", n: reduced ? 5 : 1 }), reduced ? 900 : 260);
    return () => window.clearInterval(id);
  }, [playing, reduced, dispatch]);
  useEffect(() => setSeen((s) => goals(st, s)), [st]);

  const A = st.flows.A, B = st.flows.B;
  const C = capacity(st.rate), Q = bufferPackets(st.rate, st.buffer);
  const last = st.history[st.history.length - 1];
  const s = shareA(st);
  const reveal1 = st.t >= 3;
  const bRounds = B.on ? st.t - B.joinedAt : 0;
  const reveal2 = B.on && bRounds >= 80;
  const reset = () => { setPlaying(false); setG1(null); setG2(null); setSeen({ found: false, full: false, fair: false, timeout: false }); dispatch({ type: "reset" }); };

  const guide =
    st.t === 0 ? "Answer the question, then press Play. Flow A starts sending on a link it knows nothing about."
    : !seen.found ? "Watch the window double every round trip until the queue overflows."
    : !B.on && !seen.fair ? "That drop was the queue overflowing: the only capacity signal TCP gets. Now add flow B and keep playing."
    : B.on && !reveal2 ? `Flow B has been running for ${n(bRounds, "RTT")}. Watch the dot in the phase plot.`
    : "Now break it: lose a whole window, shrink the buffer to ¼ BDP, or turn on the UDP sender.";

  return (
    <PgFrame title="One bottleneck, one or two TCP flows" onReset={reset}>
      <PgPredict<G1>
        question={`The link carries ${C} packets per round trip. Flow A starts with a window of ${IW} packets and nobody tells it the capacity. How many round trips until its window first reaches ${C}?`}
        options={[{ value: "2", label: "About 2" }, { value: "30", label: "About 30" }, { value: "rwnd", label: "1: the receiver tells it" }]}
        value={g1} onChange={setG1} revealed={reveal1} answer="2"
        explain={<>Slow start adds one packet per ACK, so the window doubles every round trip: {IW}, {IW * 2}, {IW * 4}. It is only slow compared with sending everything at once. The receiver&apos;s window says how much the receiver can buffer, not what the path can carry.</>}
      />
      {reveal1 && (
        <PgPredict<G2>
          question="Flow A has been filling the link alone. Flow B joins, starting at 10 packets. Same rules, same path. After 80 more round trips, what share does B get?"
          options={[{ value: "10", label: "About 10%: A got there first" }, { value: "30", label: "About 30%" }, { value: "50", label: "About half" }]}
          value={g2} onChange={setG2} revealed={reveal2} answer="50"
          explain={<>B now has {s === null ? "about half" : pct(1 - s)}. At every overflow both flows halve, which cuts the bigger window by more; between losses both add one packet per RTT, which leaves the gap alone. So the gap shrinks at every loss, and the phase plot walks to the diagonal.</>}
        />
      )}

      <p className="cc-guide" aria-live="polite"><span className="label">Next</span> {guide}</p>

      <div className="cc-controls">
        <div>
          <span className="label">Link rate (RTT {BASE_RTT_MS} ms)</span>
          <PgChoice<`${Rate}`> label="Link rate" value={`${st.rate}` as `${Rate}`}
            options={RATES.map((r) => ({ value: `${r}` as `${Rate}`, label: `${r} Mbit/s`, note: `${capacity(r)} packets per RTT` }))}
            onChange={(v) => dispatch({ type: "rate", rate: Number(v) as Rate })} />
        </div>
        <div>
          <span className="label">Router buffer</span>
          <PgChoice<Buffer> label="Router buffer" value={st.buffer}
            options={BUFFERS.map((b) => ({ value: b, label: BUFFER_NAME[b], note: `${bufferPackets(st.rate, b)} packets` }))}
            onChange={(v) => dispatch({ type: "buffer", buffer: v })} />
        </div>
        <div className="pg-actions">
          <PgButton primary onClick={() => setPlaying((p) => !p)}>{playing ? "Pause ❚❚" : "Play ▶"}</PgButton>
          <PgButton onClick={() => dispatch({ type: "tick" })}>+1 RTT</PgButton>
          <PgButton onClick={() => dispatch({ type: "tick", n: 10 })}>+10 RTTs</PgButton>
        </div>
      </div>

      <div className="cc-plots">
        <div className="cc-main">
          <div className="cc-legend" aria-hidden="true">
            <span className="a">cwnd A</span>{B.on && <span className="b">cwnd B</span>}<span className="ss">ssthresh A</span>
            <span className="fr">▼ halved (3 dup ACKs)</span><span className="to">✕ timeout</span>
          </div>
          <Chart st={st} />
          <div className="cc-queue" aria-label={`Router queue: ${last?.queue ?? 0} of ${Q} packets`}>
            <span className="label">Queue</span>
            <span className="cc-bar"><i style={{ width: `${Q ? ((last?.queue ?? 0) / Q) * 100 : 0}%` }} /></span>
            <span className="cc-qv">{last?.queue ?? 0}/{Q} pkts · +{Math.round(((last?.queue ?? 0) / C) * BASE_RTT_MS)} ms</span>
          </div>
        </div>
        {st.history.some((x) => x.cwnd.B !== null) && (
          <div className="cc-side">
            <span className="label">A against B</span>
            <Phase st={st} />
            <p className="muted">Each loss jumps the dot toward the origin along a line through it; each RTT of growth moves it 45° up and right. Toward the diagonal, every time.</p>
          </div>
        )}
      </div>

      <div className="pg-actions" aria-label="Break it">
        <span className="label">Break it</span>
        <PgButton onClick={() => dispatch({ type: "dropOne" })} disabled={st.pending.drop || A.phase === "timeout"} title="Drop one of flow A's packets in the next round trip">Drop 1 packet of A</PgButton>
        <PgButton onClick={() => dispatch({ type: "dropWindow" })} disabled={st.pending.window || A.phase === "timeout"} title="Lose every packet of A's next window, ACKs included">Lose A&apos;s whole window</PgButton>
        <button className={"pg-btn cc-toggle"} aria-pressed={B.on} onClick={() => dispatch({ type: "flowB" })}>{B.on ? "✓ Flow B on" : "+ Flow B"}</button>
        <button className={"pg-btn cc-toggle bad"} aria-pressed={st.udp} onClick={() => dispatch({ type: "udp" })}>{st.udp ? "✓ " : ""}UDP sender ({Math.round(C / 2)} pkts/RTT)</button>
      </div>

      <dl className="pg-stats">
        <div><dt>Round trip</dt><dd>{st.t} · {Math.round(st.ms)} ms</dd></div>
        <div><dt>cwnd A</dt><dd>{A.phase === "timeout" ? `waiting (${A.rtoLeft})` : A.cwnd} · {A.phase}</dd></div>
        <div><dt>ssthresh A</dt><dd>{Number.isFinite(A.ssthresh) ? A.ssthresh : "∞"}</dd></div>
        <div><dt>Link busy</dt><dd>{st.history.length ? pct(utilization(st)) : "–"}</dd></div>
        <div className={maxQueueMs(st) >= BASE_RTT_MS ? "bad" : ""}><dt>Worst queue delay</dt><dd>{Math.round(maxQueueMs(st))} ms</dd></div>
        <div className={A.timeouts ? "bad" : ""}><dt>Halvings · timeouts</dt><dd>{A.fastRecoveries + B.fastRecoveries} · {A.timeouts + B.timeouts}</dd></div>
        <div><dt>Share A : B</dt><dd>{s === null ? "–" : `${pct(s)} : ${pct(1 - s)}`}</dd></div>
        <div><dt>200 KB done</dt><dd>{st.responseAt === null ? "not yet" : `RTT ${st.responseAt}`}</dd></div>
      </dl>

      <div className="pg-result" aria-live="polite">
        <span className="label">What your run shows</span>
        <Result st={st} />
        <PgLog entries={st.log} empty="Events show up here: losses, halvings, timeouts, flows joining." reduced={reduced} />
      </div>

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="cc-goals">
          <li className={seen.found ? "done" : ""}>{seen.found ? "✓" : "○"} Let flow A find the capacity on its own: its first halving.</li>
          <li className={seen.full ? "done" : ""}>{seen.full ? "✓" : "○"} Keep the link over 99% busy for 60 RTTs with the smallest buffer that can do it. (Try ¼ BDP first.)</li>
          <li className={seen.fair ? "done" : ""}>{seen.fair ? "✓" : "○"} Get two flows within 5 points of 50 : 50.</li>
          <li className={seen.timeout ? "done" : ""}>{seen.timeout ? "✓" : "○"} Cause a timeout and count the round trips it costs ({RTO_ROUNDS} silent, then slow start from 1).</li>
        </ul>
      </div>

      <PgSources links={[
        { title: "WiTestLab's TCP congestion control experiment (cwnd and ssthresh of three Reno flows)", href: "https://witestlab.poly.edu/blog/tcp-congestion-control-basics/" },
        { title: "Chiu and Jain's AIMD phase plot (1989)", href: "https://www.cse.wustl.edu/~jain/papers/ftp/cong_av.pdf" },
        { title: "the TCP congestion control MicroSim spec", href: "https://dmccreary.github.io/networking/sims/tcp-congestion-control-comparison/" },
      ]} />

      <style>{`
        .cc-guide { margin: 0; font-size: .92rem; }
        .cc-guide .label { margin-right: 6px; }
        .cc-controls { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: end; }
        .cc-controls > div { display: grid; gap: 4px; }
        .cc-plots { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 14px; align-items: start; }
        .cc-plots > :only-child { grid-column: 1 / -1; }
        .cc-main, .cc-side { border: 1px solid var(--line); background: var(--bg); padding: 8px; display: grid; gap: 6px; min-width: 0; }
        .cc-side .muted { font-size: .78rem; margin: 0; }
        .cc-chart, .cc-phase { width: 100%; height: auto; display: block; }
        .cc-grid { stroke: var(--line); stroke-width: 1; }
        .cc-axis { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
        .cc-cap { stroke: var(--ink-2); stroke-width: 1.2; fill: none; }
        .cc-limit { stroke: var(--pain); stroke-width: 1.2; stroke-dasharray: 5 4; fill: none; }
        .cc-limit-l { fill: var(--pain); }
        .cc-ss { stroke: var(--accent); stroke-width: 1; stroke-dasharray: 2 3; fill: none; opacity: .8; }
        .cc-a { stroke: var(--accent); stroke-width: 2.2; fill: none; stroke-linejoin: round; }
        .cc-b { stroke: var(--ink); stroke-width: 1.8; fill: none; stroke-dasharray: 6 2; stroke-linejoin: round; }
        .cc-mark.a { fill: var(--accent); } .cc-mark.b { fill: var(--ink); }
        .cc-mark.to { stroke: var(--pain); stroke-width: 2; fill: none; }
        .cc-fair { stroke: var(--good); stroke-width: 1.2; stroke-dasharray: 4 3; }
        .cc-fair-l { fill: var(--good); }
        .cc-traj { stroke: var(--accent); stroke-width: 1.2; fill: none; opacity: .85; }
        .cc-dot { fill: var(--accent); }
        .cc-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-family: var(--f-code); font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-2); }
        .cc-legend .a { color: var(--accent); } .cc-legend .b { color: var(--ink); } .cc-legend .to { color: var(--pain); }
        .cc-queue { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; font-family: var(--f-code); font-size: .74rem; }
        .cc-bar { height: 10px; border: 1px solid var(--line); background: var(--surface); display: block; }
        .cc-bar i { display: block; height: 100%; background: var(--pain); transition: width .2s var(--ease); }
        .cc-toggle[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
        .cc-toggle.bad[aria-pressed="true"] { border-color: var(--pain); color: var(--pain); background: var(--pain-bg); }
        .cc-goals { list-style: none; padding-left: 0 !important; }
        .cc-goals li.done { color: var(--good); }
        @media (max-width: 720px) { .cc-plots { grid-template-columns: minmax(0, 1fr); } .cc-side { max-width: 260px; } }
        @media (prefers-reduced-motion: reduce) { .cc-bar i { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
