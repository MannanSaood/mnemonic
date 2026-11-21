"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, FAULT_LABEL, N, PRESET_LABEL, PROP, PROTOCOLS, PROTOCOL_NAME, RTT, TIMEOUT, TX,
  compare, configOf, init, isOneLoss, simulate, step,
  type Fault, type Packet, type Preset, type Protocol, type Result, type State,
} from "./model";

const FAULT_SHORT: Record<Fault, string> = { ok: "ok", drop: "lost", delay: "late", dup: "copy", ackdrop: "ack lost" };
const PRESETS: Preset[] = ["clean", "lose3", "loseAck", "random"];
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

/* ---------------- the sequence diagram ---------------- */

const W = 320, SX = 58, RX = 262, TOP = 22, SCALE = 2;
const y = (ms: number) => TOP + ms * SCALE;

function lineTo(p: Packet, t: number) {
  const from = p.kind === "data" ? SX : RX, to = p.kind === "data" ? RX : SX;
  const travel = p.kind === "data" ? TX + PROP : PROP;
  const lost = p.arriveT === null;
  const arrive = lost ? p.sendT + travel / 2 : p.arriveT!;
  const k = Math.min(1, Math.max(0, (t - p.sendT) / (arrive - p.sendT || 1)));
  const end = lost ? from + (to - from) / 2 : to;
  return { x1: from, y1: y(p.sendT), x2: from + (end - from) * k, y2: y(p.sendT) + (y(arrive) - y(p.sendT)) * k, done: k >= 1, lost };
}

function SeqDiagram({ r, t, reduced }: { r: Result; t: number; reduced: boolean }) {
  const height = y(Math.max(r.end, 60)) + 24;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ratio = el.clientWidth / W;
    el.scrollTo({ top: Math.max(0, y(t) * ratio - el.clientHeight * 0.6), behavior: reduced ? "auto" : "smooth" });
  }, [t, reduced]);
  const shown = r.packets.filter((p) => p.sendT <= t);
  return (
    <div className="rt-diagram" ref={box}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Sequence diagram at ${t} ms: ${shown.filter((p) => p.kind === "data").length} data packets and ${shown.filter((p) => p.kind === "ack").length} ACKs sent so far`}>
        <text x={SX} y={12} className="rt-end" textAnchor="middle">Sender</text>
        <text x={RX} y={12} className="rt-end" textAnchor="middle">Receiver</text>
        <line x1={SX} y1={TOP} x2={SX} y2={height - 8} className="rt-axis" />
        <line x1={RX} y1={TOP} x2={RX} y2={height - 8} className="rt-axis" />
        {Array.from({ length: Math.floor(Math.max(r.end, 60) / 20) + 1 }, (_, i) => (
          <g key={i}>
            <line x1={SX - 6} x2={SX} y1={y(i * 20)} y2={y(i * 20)} className="rt-axis" />
            <text x={3} y={y(i * 20) + 3} className="rt-tick">{i * 20}</text>
          </g>
        ))}
        <line x1={0} x2={W} y1={y(t)} y2={y(t)} className="rt-now" />
        {shown.map((p) => {
          const l = lineTo(p, t);
          const cls = p.kind === "ack" ? "rt-ack" + (p.dupAck && l.done ? " dup" : "") : "rt-data" + (p.retrans ? " re" : "") + (p.copy ? " copy" : "");
          return (
            <g key={p.id} className={cls}>
              <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
              {p.kind === "data" && !p.copy && <text x={SX - 5} y={l.y1 + 3} className="rt-lbl" textAnchor="end">{`${p.retrans ? "↻" : ""}${p.seq}`}</text>}
              {l.done && l.lost && <text x={l.x2} y={l.y2 + 3} textAnchor="middle" className="rt-x">✕</text>}
              {l.done && !l.lost && p.kind === "data" && (
                <text x={RX + 5} y={l.y2 + 3} className={"rt-lbl rt-out " + (p.outcome ?? "")}>
                  {p.seq} {p.outcome === "delivered" ? "✓" : p.outcome === "buffered" ? "held" : p.outcome === "duplicate" ? "old copy" : "dropped"}
                </text>
              )}
              {l.done && !l.lost && p.kind === "ack" && (
                <text x={SX + 5} y={l.y2 - 2} className="rt-lbl rt-acklbl">ACK {p.seq < 0 ? "–" : p.seq}{p.dupAck ? " again" : ""}</text>
              )}
            </g>
          );
        })}
        {r.timeouts.filter((x) => x.t <= t).map((x, i) => (
          <g key={i} className="rt-timeout">
            <circle cx={SX} cy={y(x.t)} r={4} />
            <text x={SX - 5} y={y(x.t) - 5} textAnchor="end" className="rt-lbl">timer {x.seq}</text>
          </g>
        ))}
        {r.complete && t >= r.doneAt && (
          <g className="rt-donemark">
            <line x1={SX - 40} x2={RX + 40} y1={y(r.doneAt)} y2={y(r.doneAt)} />
            <text x={(SX + RX) / 2} y={y(r.doneAt) + 12} textAnchor="middle" className="rt-lbl">all {N} acknowledged at {r.doneAt} ms</text>
          </g>
        )}
      </svg>
    </div>
  );
}

/* ---------------- sender and receiver windows at time t ---------------- */

function Windows({ st, r, t }: { st: State; r: Result; t: number }) {
  const w = st.protocol === "sw" ? 1 : st.window;
  const isAcked = (s: number) => r.ackedAt[s] >= 0 && r.ackedAt[s] <= t;
  let base = 0;
  while (base < N && isAcked(base)) base++;
  const sentBy = (s: number) => r.packets.some((p) => p.kind === "data" && p.seq === s && p.sendT <= t);
  const deliveredBy = (s: number) => r.deliveries.some((d) => d.seq === s && d.t <= t);
  const heldBy = (s: number) => !deliveredBy(s) && r.packets.some((p) => p.kind === "data" && p.seq === s && p.outcome === "buffered" && p.arriveT !== null && p.arriveT <= t);
  return (
    <div className="rt-windows">
      <div>
        <span className="label">Sender window · {w === 1 ? "one at a time" : `${w} in flight`}</span>
        <ol className="rt-cells" aria-label="Sender's messages">
          {Array.from({ length: N }, (_, s) => {
            const inWin = s >= base && s < base + w;
            const cls = isAcked(s) ? "acked" : sentBy(s) ? "sent" : inWin ? "usable" : "";
            return <li key={s} className={cls + (inWin ? " win" : "")} title={cls || "waiting for the window"}>{s}</li>;
          })}
        </ol>
      </div>
      <div>
        <span className="label">Receiver · handed to the app</span>
        <ol className="rt-cells" aria-label="Receiver's messages">
          {Array.from({ length: N }, (_, s) => (
            <li key={s} className={deliveredBy(s) ? "acked" : heldBy(s) ? "held" : ""}>{s}</li>
          ))}
        </ol>
      </div>
      <p className="rt-legend"><i className="acked" /> acknowledged / delivered <i className="sent" /> in flight <i className="usable" /> may send <i className="held" /> held, waiting for a gap</p>
    </div>
  );
}

/* ---------------- what the app received ---------------- */

function AppInbox({ r, t }: { r: Result; t: number }) {
  const got = r.deliveries.filter((d) => d.t <= t);
  return (
    <div className="rt-inbox">
      <span className="label">The app received, in order</span>
      {got.length === 0 ? <p className="pg-empty">Nothing yet.</p> : (
        <div className="rt-chips">
          {got.map((d, i) => <code key={i} className={d.dup ? "bad" : d.outOfOrder ? "warn" : ""} title={d.dup ? "a second copy" : d.outOfOrder ? "out of order" : "new, in order"}>{d.seq}{d.dup ? "×2" : ""}</code>)}
        </div>
      )}
    </div>
  );
}

function Compare({ st, all }: { st: State; all: Record<Protocol, Result> }) {
  const max = Math.max(...PROTOCOLS.map((p) => all[p].doneAt));
  return (
    <div className="rt-compare">
      <span className="label">Same trouble, all three designs</span>
      {PROTOCOLS.map((p) => {
        const r = all[p];
        return (
          <div key={p} className={"rt-bar" + (p === st.protocol ? " on" : "")}>
            <span className="rt-bname">{PROTOCOL_NAME[p]}</span>
            <span className="rt-btrack"><i style={{ width: `${(r.doneAt / max) * 100}%` }} /></span>
            <span className="rt-bval">{r.doneAt} ms · {n(r.retransmissions, "resend")}</span>
          </div>
        );
      })}
    </div>
  );
}

function ResultLine({ st, r, all }: { st: State; r: Result; all: Record<Protocol, Result> }) {
  if (st.t < r.end) return null;
  const faults = st.faults.filter((f) => f !== "ok").length;
  const other = PROTOCOLS.filter((p) => p !== st.protocol);
  const sw = all.sw;
  const takeaway = r.dupDelivered > 0 || r.missing > 0
    ? `Without checking sequence numbers, the receiver cannot tell a resent copy from a new message${r.missing ? ", or notice a gap" : ""}. Your app got ${n(r.dupDelivered, "duplicate")}${r.missing ? ` and lost ${n(r.missing, "message")}` : ""}. Numbers are what turn "at least once" into "exactly once, in order".`
    : st.protocol === "sw"
      ? `Stop-and-wait is reliable, but the sender's link carried data only ${Math.round(r.utilisation * 100)}% of the time. Each message costs a full round trip (${RTT} ms) for ${TX} ms of sending.`
      : st.protocol === "gbn" && r.retransmissions > 1
        ? `Go-back-N resent ${n(r.retransmissions, "packet")} because its receiver throws away anything that arrives after a gap. Selective repeat resent ${all.sr.retransmissions} for the same trouble, at the price of a receiver buffer.`
        : `A window of ${st.window} kept the link busy: ${Math.round((sw.doneAt / r.doneAt) * 10) / 10}× faster than stop-and-wait. The numbers, ACKs and timer did the same job as before; pipelining only stopped the sender waiting.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your run cost</span>
      <p>
        {PROTOCOL_NAME[st.protocol]}{st.protocol !== "sw" ? `, window ${st.window}` : ""}, {faults ? n(faults, "fault") : "a clean link"}:
        {" "}{N} messages took {r.doneAt} ms and {n(r.dataSent, "data packet")} ({n(r.retransmissions, "resend")}).
        {" "}With the same trouble, {PROTOCOL_NAME[other[0]].toLowerCase()} took {all[other[0]].doneAt} ms with {n(all[other[0]].retransmissions, "resend")}, and {PROTOCOL_NAME[other[1]].toLowerCase()} {all[other[1]].doneAt} ms with {n(all[other[1]].retransmissions, "resend")}.
      </p>
      <p className="pg-takeaway">{takeaway}</p>
    </div>
  );
}

export default function ReliableTransferPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const cfg = configOf(st);
  const r = useMemo(() => simulate(cfg), [cfg.protocol, cfg.window, cfg.seqCheck, cfg.faults.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => compare(st), [cfg.window, cfg.seqCheck, cfg.faults.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const finished = st.t >= r.end;

  useEffect(() => {
    if (!playing) return;
    if (finished) { setPlaying(false); return; }
    const id = window.setInterval(() => dispatch({ type: "tick", ms: 1 }), 22);
    return () => window.clearInterval(id);
  }, [playing, finished, dispatch]);

  const play = () => {
    if (reduced) { dispatch({ type: "toEnd" }); return; }
    if (finished) dispatch({ type: "rewind" });
    setPlaying((p) => !p || finished);
  };
  const change = (a: Parameters<typeof dispatch>[0]) => { setPlaying(false); dispatch(a); };

  const gbnOne = isOneLoss(st.faults) && st.protocol === "gbn";
  return (
    <PgFrame title="A sender, a receiver and a link you can break" onReset={() => { setPlaying(false); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <PgPredict
        question="Go-back-N, window 4. Packet 3 is lost on the way. When the timer fires, what does the sender resend?"
        options={[{ value: "one", label: "Just packet 3" }, { value: "after", label: "Packet 3 and everything it sent after 3" }, { value: "all", label: "All 10 messages" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.revealed}
        answer="after"
        explain="Packet 3 and every packet sent after it. The go-back-N receiver only accepts the next number it expects, so it threw away 4, 5 and 6 when they arrived early. The sender has to send them again. Switch to selective repeat to see only packet 3 resent. (Try it: pick Go-back-N and the Lose packet 3 preset, then press Play.)"
      />

      <div className="pg-card">
        <span className="label">Design</span>
        <div className="rt-controls">
          <PgChoice label="Protocol" value={st.protocol}
            options={PROTOCOLS.map((p) => ({ value: p, label: PROTOCOL_NAME[p] }))}
            onChange={(p) => change({ type: "protocol", protocol: p })} />
          <label className="rt-range">
            <span className="label">Window {st.protocol === "sw" ? "1 (fixed)" : st.window}</span>
            <input type="range" min={2} max={8} value={st.window} disabled={st.protocol === "sw"}
              onChange={(e) => change({ type: "window", window: Number(e.target.value) })} aria-label="Window size" />
          </label>
          <label className="rt-check">
            <input type="checkbox" checked={st.seqCheck} onChange={(e) => change({ type: "seqCheck", on: e.target.checked })} />
            Receiver checks sequence numbers
          </label>
        </div>
      </div>

      <div className="pg-card">
        <span className="label">The link · click a packet to choose what happens to its first send</span>
        <ol className="rt-plan">
          {st.faults.map((f, i) => (
            <li key={i}>
              <button className={"rt-fault " + f} onClick={() => change({ type: "cycleFault", seq: i })}
                aria-label={`Packet ${i}: ${FAULT_LABEL[f]}. Click to change.`} title={FAULT_LABEL[f]}>
                <b>{i}</b><span>{FAULT_SHORT[f]}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="pg-actions">
          {PRESETS.map((p) => <PgButton key={p} onClick={() => change({ type: "preset", name: p })}>{PRESET_LABEL[p]}</PgButton>)}
        </div>
        <p className="pg-note">Each packet takes {TX} ms to send and {PROP} ms to cross; a round trip is {RTT} ms. The retransmit timer is {TIMEOUT} ms. Faults hit the first send only; resends get through.</p>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <div className="rt-transport">
            <PgButton primary onClick={play}>{reduced ? "Run" : playing ? "Pause" : finished ? "Replay" : st.t > 0 ? "Resume" : "Play"}</PgButton>
            <PgButton onClick={() => { setPlaying(false); dispatch({ type: "toEnd" }); }} disabled={finished}>Skip to end</PgButton>
            <span className="rt-clock">t = {Math.min(st.t, r.end)} ms</span>
          </div>
          <SeqDiagram r={r} t={st.t} reduced={reduced} />
        </div>
        <div className="pg-card">
          <Windows st={st} r={r} t={st.t} />
          <dl className="pg-stats">
            <div><dt>Time</dt><dd>{finished ? `${r.doneAt} ms` : "…"}</dd></div>
            <div><dt>Data sent</dt><dd>{r.packets.filter((p) => p.kind === "data" && !p.copy && p.sendT <= st.t).length}</dd></div>
            <div className={r.retransmissions > 1 && finished ? "bad" : ""}><dt>Resends</dt><dd>{r.packets.filter((p) => p.kind === "data" && p.retrans && !p.copy && p.sendT <= st.t).length}</dd></div>
            <div className={finished && (r.dupDelivered || r.missing) ? "bad" : ""}><dt>App errors</dt><dd>{r.deliveries.filter((d) => d.t <= st.t && d.dup).length + (finished ? r.missing : 0)}</dd></div>
          </dl>
          <AppInbox r={r} t={st.t} />
          {finished && <Compare st={st} all={all} />}
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="rt-ch">
          {CHALLENGES.map((c) => {
            const ok = st.done.includes(c.id);
            return <li key={c.id} className={ok ? "done" : ""}>{ok ? "✓ " : ""}{c.text}</li>;
          })}
        </ol>
        {gbnOne && !finished && <p className="pg-note">Press Play to see what go-back-N resends.</p>}
      </div>

      <ResultLine st={st} r={r} all={all} />

      <PgSources links={[
        { title: "TU Berlin's Go-Back-N and Selective Repeat animation", href: "https://www.tkn.tu-berlin.de/teaching/rn/animations/gbn_sr/" },
        { title: "Kurose and Ross's Go-Back-N applet (U. Delaware)", href: "https://www.eecis.udel.edu/~amer/450/TransportApplets/GBN/GBNindex.html" },
        { title: "the ARQ protocols comparison MicroSim", href: "https://dmccreary.github.io/networking/sims/arq-protocols-comparison/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.rt-controls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
.rt-range { display: grid; gap: 2px; }
.rt-range input { width: 140px; accent-color: var(--accent); }
.rt-check { display: flex; gap: 6px; align-items: center; font-size: .92rem; }
.rt-plan { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 4px; }
.rt-fault { width: 100%; border: 1px solid var(--line); background: var(--surface); padding: 4px 0; display: grid; gap: 1px; justify-items: center; font-family: var(--f-code); }
.rt-fault b { font-size: .85rem; }
.rt-fault span { font-size: .52rem; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-2); white-space: nowrap; }
.rt-fault:not(.ok) { border-color: var(--pain); background: var(--pain-bg); }
.rt-fault:not(.ok) span { color: var(--pain); }
.rt-transport { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rt-clock { font-family: var(--f-code); font-size: .8rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.rt-diagram { max-height: 470px; overflow-y: auto; border: 1px solid var(--line); background-color: var(--surface);
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 16px 16px; }
.rt-diagram svg { display: block; width: 100%; height: auto; font-family: var(--f-code); }
.rt-end { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; fill: var(--ink); }
.rt-axis { stroke: var(--ink-2); stroke-width: 1.2; }
.rt-tick { font-size: 6.5px; fill: var(--ink-2); }
.rt-now { stroke: var(--accent); stroke-width: .6; stroke-dasharray: 2 2; }
.rt-lbl { font-size: 7px; fill: var(--ink-2); }
.rt-data line { stroke: var(--accent); stroke-width: 1.4; }
.rt-data .rt-lbl { fill: var(--accent); }
.rt-data.re line { stroke: var(--pain); }
.rt-data.re .rt-lbl { fill: var(--pain); }
.rt-data.copy line { stroke-dasharray: 1 2; }
.rt-ack line { stroke: var(--ink-2); stroke-width: .9; stroke-dasharray: 3 2; }
.rt-ack.dup .rt-acklbl { fill: var(--pain); }
.rt-x { font-size: 10px; fill: var(--pain); }
.rt-out.delivered { fill: var(--good); }
.rt-out.duplicate, .rt-out.discarded { fill: var(--pain); }
.rt-out.buffered { fill: var(--accent); }
.rt-timeout circle { fill: var(--pain-bg); stroke: var(--pain); }
.rt-timeout text { fill: var(--pain); }
.rt-donemark line { stroke: var(--good); stroke-width: 1; }
.rt-donemark text { fill: var(--good); }
.rt-windows { display: grid; gap: 8px; }
.rt-cells { list-style: none; margin: 2px 0 0; padding: 0; display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 2px; }
.rt-cells li { border: 1px solid var(--line); background: var(--surface); text-align: center; font-family: var(--f-code); font-size: .72rem; padding: 2px 0; transition: background .2s var(--ease); }
.rt-cells li.win { border-top: 3px solid var(--accent); }
.rt-cells li.acked { background: var(--good-bg); color: var(--good); }
.rt-cells li.sent { background: var(--hl); }
.rt-cells li.usable { border-style: dashed; }
.rt-cells li.held { background: var(--hl); outline: 1px solid var(--accent); }
.rt-legend { margin: 0; font-size: .72rem; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: center; }
.rt-legend i { display: inline-block; width: 10px; height: 10px; border: 1px solid var(--line); margin-right: 3px; vertical-align: -1px; }
.rt-legend i.acked { background: var(--good-bg); } .rt-legend i.sent { background: var(--hl); } .rt-legend i.usable { border-style: dashed; } .rt-legend i.held { background: var(--hl); outline: 1px solid var(--accent); }
.rt-inbox { display: grid; gap: 4px; }
.rt-chips { display: flex; flex-wrap: wrap; gap: 3px; }
.rt-chips code { font-size: .74rem; }
.rt-chips code.bad { background: var(--pain-bg); color: var(--pain); }
.rt-chips code.warn { outline: 1px dashed var(--pain); }
.rt-compare { display: grid; gap: 4px; }
.rt-bar { display: grid; grid-template-columns: 8.5em minmax(0, 1fr) auto; gap: 6px; align-items: center; font-size: .8rem; color: var(--ink-2); }
.rt-bar.on { color: var(--ink); font-weight: 600; }
.rt-bname { font-family: var(--f-code); font-size: .64rem; text-transform: uppercase; letter-spacing: .04em; }
.rt-btrack { height: 8px; background: var(--surface-2); }
.rt-btrack i { display: block; height: 100%; background: var(--ink-2); }
.rt-bar.on .rt-btrack i { background: var(--accent); }
.rt-bval { font-family: var(--f-code); font-size: .68rem; font-variant-numeric: tabular-nums; }
.rt-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.rt-ch li.done { color: var(--good); }
@media (max-width: 520px) {
  .rt-plan { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .rt-bar { grid-template-columns: 1fr auto; }
  .rt-btrack { grid-column: 1 / -1; grid-row: 2; }
}
@media (prefers-reduced-motion: reduce) { .rt-cells li { transition: none; } }
`;
