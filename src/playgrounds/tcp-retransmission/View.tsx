"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, DUP_THRESH, FAULT_LABEL, FLOOR_MS, N, TX, WINDOW,
  clean, configOf, dupAcksAt, estimatorAt, init, simulate, step,
  type Action, type Ev, type Fault, type Floor, type Jitter, type Packet, type Result, type State,
} from "./model";

const FAULT_SHORT: Record<Fault, string> = { ok: "ok", drop: "lost", drop2: "lost ×2", late: "late" };
const JITTERS: { value: Jitter; label: string }[] = [{ value: "none", label: "Steady" }, { value: "some", label: "Some jitter" }, { value: "wild", label: "Wild jitter" }];
const FLOORS: { value: Floor; label: string; note: string }[] = [
  { value: "linux", label: "Linux: 200 ms", note: "Linux never lets the RTO drop below 200 ms." },
  { value: "rfc", label: "RFC 6298: 1 s", note: "RFC 6298 says the RTO SHOULD be rounded up to 1 second." },
];
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const ms = (x: number) => `${Math.round(x)} ms`;

/* ---------------- sequence diagram ---------------- */

const W = 320, SX = 58, RX = 262, TOP = 22;

function SeqDiagram({ r, t, scale, reduced }: { r: Result; t: number; scale: number; reduced: boolean }) {
  const y = (x: number) => TOP + x * scale;
  const height = y(r.end) + 26;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTo({ top: Math.max(0, y(t) * (el.clientWidth / W) - el.clientHeight * 0.6), behavior: reduced ? "auto" : "smooth" });
  }, [t, reduced]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = Math.max(20, Math.ceil(60 / scale / 20) * 20);
  const shown = r.packets.filter((p) => p.sendT <= t);
  const line = (p: Packet) => {
    const from = p.kind === "data" ? SX : RX, to = p.kind === "data" ? RX : SX;
    const lost = p.arriveT === null;
    const arrive = lost ? p.sendT + 20 : p.arriveT!;
    const k = Math.min(1, Math.max(0, (t - p.sendT) / (arrive - p.sendT || 1)));
    const end = lost ? from + (to - from) * 0.45 : to;
    return { x1: from, y1: y(p.sendT), x2: from + (end - from) * k, y2: y(p.sendT) + (y(arrive) - y(p.sendT)) * k, done: k >= 1, lost };
  };
  const marks = r.events.filter((e) => (e.kind === "timeout" || e.kind === "fast") && e.t <= t);
  return (
    <div className="rx-diagram" ref={box}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Sequence diagram at ${Math.round(t)} ms`}>
        <text x={SX} y={12} textAnchor="middle" className="rx-end">Sender</text>
        <text x={RX} y={12} textAnchor="middle" className="rx-end">Receiver</text>
        <line x1={SX} x2={SX} y1={TOP} y2={height - 6} className="rx-axis" />
        <line x1={RX} x2={RX} y1={TOP} y2={height - 6} className="rx-axis" />
        {Array.from({ length: Math.floor(r.end / step) + 1 }, (_, i) => (
          <text key={i} x={3} y={y(i * step) + 3} className="rx-tick">{i * step}</text>
        ))}
        <line x1={0} x2={W} y1={y(t)} y2={y(t)} className="rx-now" />
        {shown.map((p) => {
          const l = line(p);
          const cls = p.kind === "ack" ? "rx-ack" + (p.dup ? " dup" : "") : "rx-data" + (p.retrans ? " re" : "") + (p.needless && l.done ? " needless" : "");
          return (
            <g key={p.id} className={cls}>
              <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
              {p.kind === "data" && <text x={SX - 4} y={l.y1 + 3} textAnchor="end" className="rx-lbl">{p.retrans ? "↻" : ""}{p.seq}</text>}
              {l.done && l.lost && <text x={l.x2} y={l.y2 + 3} textAnchor="middle" className="rx-x">✕</text>}
              {p.kind === "ack" && l.done && p.dup > 0 && <text x={SX + 4} y={l.y2 + 2} className="rx-lbl rx-duplbl">dup ACK {p.seq} #{p.dup}</text>}
            </g>
          );
        })}
        {marks.map((e, i) => (
          <g key={i} className={e.kind === "timeout" ? "rx-mark timeout" : "rx-mark fast"}>
            <rect x={SX - 3} y={y(e.t) - 3} width={6} height={6} />
            <text x={SX - 6} y={y(e.t) - 5} textAnchor="end" className="rx-lbl">{e.kind === "timeout" ? `RTO fired` : `3 dup ACKs`}</text>
          </g>
        ))}
        {r.complete && t >= r.doneAt && (
          <g className="rx-donemark">
            <line x1={SX - 30} x2={RX + 30} y1={y(r.doneAt)} y2={y(r.doneAt)} />
            <text x={(SX + RX) / 2} y={y(r.doneAt) + 11} textAnchor="middle" className="rx-lbl">all {N} acknowledged at {r.doneAt} ms</text>
          </g>
        )}
      </svg>
    </div>
  );
}

/* ---------------- the RTT chart: samples, SRTT and RTO over time ---------------- */

function RttChart({ r, t }: { r: Result; t: number }) {
  const CW = 320, CH = 150, L = 34, R = 8, T = 10, B = 20;
  const samples = r.events.filter((e): e is Extract<Ev, { kind: "sample" }> => e.kind === "sample");
  const maxSample = Math.max(10, ...samples.map((s) => s.r));
  const rtoPts: { t: number; v: number }[] = [{ t: 0, v: 1000 }];
  for (const e of r.events) if (e.kind === "sample" || e.kind === "timeout") rtoPts.push({ t: e.t, v: e.rto });
  const yMax = Math.min(Math.max(maxSample * 1.3, ...rtoPts.slice(1).map((p) => p.v)) * 1.08, maxSample * 7);
  const x = (v: number) => L + (v / Math.max(1, r.end)) * (CW - L - R);
  const y = (v: number) => T + (1 - Math.min(v, yMax) / yMax) * (CH - T - B);
  const vis = (p: { t: number }) => p.t <= t;
  // step line for RTO, up to t
  let rtoPath = "";
  const rp = rtoPts.filter(vis);
  rp.forEach((p, i) => {
    rtoPath += i === 0 ? `M${x(p.t)},${y(p.v)}` : `H${x(p.t)}V${y(p.v)}`;
  });
  if (rp.length) rtoPath += `H${x(Math.min(t, r.end))}`;
  const sv = samples.filter(vis);
  const srttPath = sv.map((s, i) => `${i ? "L" : "M"}${x(s.t)},${y(s.srtt)}`).join("");
  const ticks = [0, yMax / 2, yMax].map((v) => Math.round(v / 10) * 10);
  return (
    <svg className="rx-chart" viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label="Round-trip samples, smoothed RTT and retransmission timeout over time">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={CW - R} y1={y(v)} y2={y(v)} className="rx-grid" />
          <text x={L - 4} y={y(v) + 3} textAnchor="end" className="rx-tick">{v}</text>
        </g>
      ))}
      <text x={L} y={CH - 5} className="rx-tick">0 ms</text>
      <text x={CW - R} y={CH - 5} textAnchor="end" className="rx-tick">{r.end} ms</text>
      <path d={rtoPath} className="rx-rto" />
      <path d={srttPath} className="rx-srtt" />
      {sv.map((s, i) => <circle key={i} cx={x(s.t)} cy={y(s.r)} r={2.2} className="rx-sample" />)}
      {r.events.filter((e) => e.kind === "timeout" && e.t <= t).map((e, i) => (
        <line key={i} x1={x(e.t)} x2={x(e.t)} y1={T} y2={CH - B} className="rx-tomark" />
      ))}
      <line x1={x(Math.min(t, r.end))} x2={x(Math.min(t, r.end))} y1={T} y2={CH - B} className="rx-nowv" />
    </svg>
  );
}

function Formula({ r, t, floor }: { r: Result; t: number; floor: number }) {
  const est = estimatorAt(r, t);
  const e = est.last;
  if (!e) return <p className="pg-empty">No round trip measured yet. Until the first sample, RTO is 1 s (RFC 6298).</p>;
  if (e.kind === "karn") return <p className="rx-eq">ACK for segment {e.seg}, which was sent more than once. No sample: the ACK might be for either copy (Karn&apos;s algorithm). RTO stays {ms(est.rto)}.</p>;
  if (e.kind === "timeout") return <p className="rx-eq bad">Timer expired waiting for segment {e.seg}. RTO = 2 × {f1(e.oldRto)} = <b>{f1(e.rto)} ms</b> (back off; it stays doubled until a clean sample arrives).</p>;
  if (e.kind !== "sample") return null;
  const raw = e.srtt + Math.max(1, 4 * e.rttvar);
  return (
    <div className="rx-eq">
      <p>R = <b>{e.r} ms</b> (segment {e.seg})</p>
      {e.prevSrtt === null ? (
        <>
          <p>SRTT = R = {f1(e.srtt)}</p>
          <p>RTTVAR = R / 2 = {f1(e.rttvar)}</p>
        </>
      ) : (
        <>
          <p>RTTVAR = ¾ × {f1(e.prevRttvar!)} + ¼ × |{f1(e.prevSrtt)} − {e.r}| = {f1(e.rttvar)}</p>
          <p>SRTT = ⅞ × {f1(e.prevSrtt)} + ⅛ × {e.r} = {f1(e.srtt)}</p>
        </>
      )}
      <p>RTO = {f1(e.srtt)} + 4 × {f1(e.rttvar)} = {f1(raw)}{e.floored ? ` → floor ${floor}` : ""} = <b>{f1(e.rto)} ms</b></p>
    </div>
  );
}

function ResultLine({ st, r }: { st: State; r: Result }) {
  const base = useMemo(() => simulate({ ...configOf(st), faults: clean() }), [st.baseRtt, st.jitter, st.floor, st.sack]); // eslint-disable-line react-hooks/exhaustive-deps
  if (st.t < r.end) return null;
  const timeoutsAfterTO = r.events.filter((e) => e.kind === "timeout");
  const maxRto = Math.max(r.finalRto, ...timeoutsAfterTO.map((e) => (e.kind === "timeout" ? e.rto : 0)));
  const take = r.timeouts > 0
    ? `Each timeout waited a full RTO, at least ${FLOOR_MS[st.floor]} ms, on a ${st.baseRtt} ms path, and a second timeout for the same data waited twice as long. Only the timer can find a loss with nothing sent after it, or a lost resend.`
    : r.fast > 0
      ? `The segments after the loss produced duplicate ACKs, and the third one triggered the resend about one round trip after the loss, far sooner than the ${FLOOR_MS[st.floor]} ms timer.`
      : r.needless > 0
        ? "Nothing was lost, yet TCP sent a copy the receiver already had: a late segment looks exactly like a lost one until it arrives."
        : `With no loss, the estimator settled near the path's round trip, and the ${FLOOR_MS[st.floor]} ms floor set the RTO. Lose a segment to see which mechanism finds it.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your losses cost</span>
      <p>
        {N} segments took {r.doneAt} ms; with nothing lost this path takes {base.doneAt} ms. {n(r.retransmissions, "segment")} resent:
        {" "}{r.fast} by fast retransmit, {n(r.timeouts, "timeout")}{r.timeouts ? ` (RTO reached ${ms(maxRto)})` : ""}.
        {r.needless ? ` ${n(r.needless, "copy", "copies")} reached a receiver that already had the data.` : ""}
        {r.finalSrtt !== null ? ` Final SRTT ${f1(r.finalSrtt)} ms, RTO ${ms(r.finalRto)}.` : ""}
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function TcpRetransmissionPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const cfg = configOf(st);
  const key = `${cfg.baseRtt}|${cfg.jitter}|${cfg.floor}|${cfg.sack}|${cfg.faults.join()}`;
  const r = useMemo(() => simulate(cfg), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const scale = useMemo(() => {
    const c = simulate({ ...cfg, faults: clean() });
    return Math.max(0.45, Math.min(2.2, 440 / Math.max(1, c.end)));
  }, [cfg.baseRtt, cfg.jitter]); // eslint-disable-line react-hooks/exhaustive-deps
  const finished = st.t >= r.end;
  const speed = Math.max(1, Math.round(st.baseRtt / 30));

  useEffect(() => {
    if (!playing) return;
    if (finished) { setPlaying(false); return; }
    const id = window.setInterval(() => dispatch({ type: "tick", ms: speed }), 24);
    return () => window.clearInterval(id);
  }, [playing, finished, speed, dispatch]);

  const change = (a: Action) => { setPlaying(false); dispatch(a); };
  const play = () => {
    if (reduced) { dispatch({ type: "toEnd" }); return; }
    if (finished) dispatch({ type: "rewind" });
    setPlaying((p) => !p || finished);
  };

  const est = estimatorAt(r, st.t);
  const dups = dupAcksAt(r, st.t);
  const resentSoFar = r.packets.filter((p) => p.kind === "data" && p.retrans && p.sendT <= st.t).length;

  return (
    <PgFrame title="Drop a segment, watch the timer learn" onReset={() => { setPlaying(false); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <PgPredict
        question="Segment 7 of 20 is lost; 8 to 12 arrive. What makes the sender resend 7?"
        options={[
          { value: "timer", label: "Its retransmit timer, 200 ms or more later" },
          { value: "dup", label: "Three duplicate ACKs, about one round trip later" },
          { value: "app", label: "Nothing, until the application retries" },
        ]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.revealed}
        answer="dup"
        explain="Duplicate ACKs. Each segment after the gap makes the receiver repeat ACK 7 (the next byte it wants). On the third repeat the sender resends 7 at once: fast retransmit. The timer is the fallback for losses with nothing after them. Click segment 7 to lose it and press Play."
      />

      <div className="pg-card">
        <span className="label">The path</span>
        <div className="rx-controls">
          <label className="rx-range">
            <span className="label">Round trip {st.baseRtt} ms</span>
            <input type="range" min={20} max={200} step={10} value={st.baseRtt} onChange={(e) => change({ type: "rtt", ms: Number(e.target.value) })} aria-label="Path round-trip time" />
          </label>
          <PgChoice label="Jitter" value={st.jitter} options={JITTERS} onChange={(v) => change({ type: "jitter", value: v })} />
          <PgChoice label="Minimum RTO" value={st.floor} options={FLOORS} onChange={(v) => change({ type: "floor", value: v })} />
          <label className="rx-check">
            <input type="checkbox" checked={st.sack} onChange={(e) => change({ type: "sack", on: e.target.checked })} />
            SACK (receiver reports which later segments arrived)
          </label>
        </div>
        <span className="label">Segments · click one to choose its fate</span>
        <ol className="rx-plan">
          {st.faults.map((f, i) => (
            <li key={i}>
              <button className={"rx-fault " + f} onClick={() => change({ type: "cycleFault", seq: i + 1 })}
                aria-label={`Segment ${i + 1}: ${FAULT_LABEL[f]}. Click to change.`} title={FAULT_LABEL[f]}>
                <b>{i + 1}</b><span>{FAULT_SHORT[f]}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="pg-actions">
          <PgButton onClick={() => change({ type: "clear" })}>Lose nothing</PgButton>
          <PgButton onClick={() => change({ type: "setFault", seq: 7, fault: "drop" })}>Lose 7</PgButton>
          <PgButton onClick={() => change({ type: "setFault", seq: N, fault: "drop" })}>Lose the last one</PgButton>
        </div>
        <p className="pg-note">The sender may have {WINDOW} segments unacknowledged and needs {TX} ms to send each. The receiver ACKs every segment at once. Congestion control is left out here; it comes in a later lesson.</p>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <div className="rx-transport">
            <PgButton primary onClick={play}>{reduced ? "Run" : playing ? "Pause" : finished ? "Replay" : st.t > 0 ? "Resume" : "Play"}</PgButton>
            <PgButton onClick={() => { setPlaying(false); dispatch({ type: "toEnd" }); }} disabled={finished}>Skip to end</PgButton>
            <span className="rx-clock">t = {Math.round(Math.min(st.t, r.end))} ms</span>
          </div>
          <SeqDiagram r={r} t={st.t} scale={scale} reduced={reduced} />
        </div>
        <div className="pg-card">
          <span className="label">The sender&apos;s estimator (RFC 6298)</span>
          <dl className="pg-stats">
            <div><dt>SRTT</dt><dd>{est.srtt === null ? "–" : `${f1(est.srtt)} ms`}</dd></div>
            <div><dt>RTTVAR</dt><dd>{est.rttvar === null ? "–" : `${f1(est.rttvar)} ms`}</dd></div>
            <div className={est.last?.kind === "timeout" ? "bad" : ""}><dt>RTO</dt><dd>{ms(est.rto)}</dd></div>
            <div className={dups >= DUP_THRESH ? "bad" : ""}><dt>Dup ACKs</dt><dd>{dups}{dups >= DUP_THRESH ? " ⚡" : ""}</dd></div>
          </dl>
          <Formula r={r} t={st.t} floor={FLOOR_MS[st.floor]} />
          <RttChart r={r} t={st.t} />
          <p className="rx-legend"><i className="s" /> RTT sample <i className="m" /> SRTT <i className="o" /> RTO <i className="t" /> timeout</p>
          <dl className="pg-stats">
            <div><dt>Time</dt><dd>{finished ? `${r.doneAt} ms` : "…"}</dd></div>
            <div className={resentSoFar ? "bad" : ""}><dt>Resent</dt><dd>{resentSoFar}</dd></div>
            <div><dt>Fast / timer</dt><dd>{r.events.filter((e) => e.kind === "fast" && e.t <= st.t).length} / {r.events.filter((e) => e.kind === "timeout" && e.t <= st.t).length}</dd></div>
            <div className={finished && r.needless ? "bad" : ""}><dt>Needless</dt><dd>{finished ? r.needless : "…"}</dd></div>
          </dl>
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="rx-ch">
          {CHALLENGES.map((c) => {
            const ok = st.done.includes(c.id);
            return <li key={c.id} className={ok ? "done" : ""}>{ok ? "✓ " : ""}{c.text}</li>;
          })}
        </ol>
      </div>

      <ResultLine st={st} r={r} />

      <PgSources links={[
        { title: "ISI's Javis animation of fast retransmit", href: "https://www.isi.edu/websites/nsnam/DIRECTED_RESEARCH/DR_WANIDA/DR/JavisInActionFastRetransmitFrame.html" },
        { title: "Kurose and Ross's interactive TCP exercises", href: "https://www-net.cs.umass.edu/kurose_ross/interactive/tcp_evolution.php" },
        { title: "RFC 6298", href: "https://www.rfc-editor.org/rfc/rfc6298.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.rx-controls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
.rx-range { display: grid; gap: 2px; }
.rx-range input { width: 160px; accent-color: var(--accent); }
.rx-check { display: flex; gap: 6px; align-items: center; font-size: .92rem; }
.rx-plan { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 4px; }
.rx-fault { width: 100%; border: 1px solid var(--line); background: var(--surface); padding: 3px 0; display: grid; justify-items: center; font-family: var(--f-code); }
.rx-fault b { font-size: .82rem; }
.rx-fault span { font-size: .5rem; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-2); white-space: nowrap; }
.rx-fault:not(.ok) { border-color: var(--pain); background: var(--pain-bg); }
.rx-fault:not(.ok) span { color: var(--pain); }
.rx-transport { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rx-clock { font-family: var(--f-code); font-size: .8rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.rx-diagram { max-height: 520px; overflow-y: auto; border: 1px solid var(--line); background-color: var(--surface);
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 16px 16px; }
.rx-diagram svg { display: block; width: 100%; height: auto; font-family: var(--f-code); }
.rx-end { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; fill: var(--ink); }
.rx-axis { stroke: var(--ink-2); stroke-width: 1.2; }
.rx-tick { font-size: 6.5px; fill: var(--ink-2); font-family: var(--f-code); }
.rx-now { stroke: var(--accent); stroke-width: .6; stroke-dasharray: 2 2; }
.rx-lbl { font-size: 6.5px; fill: var(--ink-2); }
.rx-data line { stroke: var(--accent); stroke-width: 1.2; }
.rx-data .rx-lbl { fill: var(--accent); }
.rx-data.re line { stroke: var(--pain); stroke-width: 1.6; }
.rx-data.re .rx-lbl { fill: var(--pain); font-weight: 700; }
.rx-data.needless line { stroke-dasharray: 2 2; }
.rx-ack line { stroke: var(--ink-2); stroke-width: .7; stroke-dasharray: 3 2; }
.rx-ack.dup line { stroke: var(--pain); }
.rx-duplbl { fill: var(--pain); }
.rx-x { font-size: 10px; fill: var(--pain); }
.rx-mark rect { stroke-width: 1; }
.rx-mark.timeout rect { fill: var(--pain-bg); stroke: var(--pain); }
.rx-mark.timeout text { fill: var(--pain); font-weight: 700; }
.rx-mark.fast rect { fill: var(--hl); stroke: var(--accent); }
.rx-mark.fast text { fill: var(--accent); font-weight: 700; }
.rx-donemark line { stroke: var(--good); }
.rx-donemark text { fill: var(--good); }
.rx-chart { width: 100%; height: auto; display: block; border: 1px solid var(--line); background: var(--surface); }
.rx-grid { stroke: var(--grid); stroke-width: 1; }
.rx-rto { fill: none; stroke: var(--pain); stroke-width: 1.6; }
.rx-srtt { fill: none; stroke: var(--accent); stroke-width: 1.6; }
.rx-sample { fill: var(--ink-2); }
.rx-tomark { stroke: var(--pain); stroke-width: 1; stroke-dasharray: 2 2; }
.rx-nowv { stroke: var(--ink-2); stroke-width: .6; stroke-dasharray: 1 2; }
.rx-legend { margin: 0; font-size: .72rem; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: center; }
.rx-legend i { display: inline-block; width: 12px; height: 3px; margin-right: 3px; vertical-align: 2px; }
.rx-legend i.s { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-2); vertical-align: 0; }
.rx-legend i.m { background: var(--accent); } .rx-legend i.o { background: var(--pain); }
.rx-legend i.t { border-left: 1px dashed var(--pain); width: 1px; height: 10px; vertical-align: -1px; }
.rx-eq { display: grid; gap: 1px; font-family: var(--f-code); font-size: .72rem; border-left: 3px solid var(--accent); padding: 4px 8px; background: var(--surface); margin: 0; }
.rx-eq p { margin: 0; }
.rx-eq.bad, p.rx-eq.bad { border-left-color: var(--pain); }
p.rx-eq { font-family: var(--f-text); font-size: .9rem; }
.rx-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.rx-ch li.done { color: var(--good); }
@media (max-width: 520px) { .rx-plan { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
`;
