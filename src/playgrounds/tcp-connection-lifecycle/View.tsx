"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, CONNECT_TIMEOUT_MS, DROPPABLE, INITIAL_RTO, LABEL_NAME, ONE_WAY, SYN_RETRIES, TIME_WAIT_MS,
  configOf, init, rowStates, simulate, startStates, step, timeOf,
  type Action, type ConnectTimeout, type Result, type Row, type ServerMode, type State, type TcpState,
} from "./model";

const MODES: { value: ServerMode; label: string; note: string }[] = [
  { value: "listen", label: "Listening", note: "The database accepts connections." },
  { value: "closed", label: "Port closed", note: "Nothing listens on the port; the host's kernel answers with a reset." },
  { value: "filtered", label: "Firewall drops SYNs", note: "A firewall silently discards the client's SYNs. Nothing comes back." },
];
const TIMEOUTS: { value: ConnectTimeout; label: string; note: string }[] = [
  { value: "none", label: "None (kernel decides)", note: "The app waits as long as the kernel keeps resending the SYN." },
  { value: "3s", label: "3 s", note: "The app gives up on connect() after 3 seconds." },
];

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const ms = (t: number) => (t >= 10_000 ? `${Math.round(t / 1000)} s` : t >= 1000 ? `${(t / 1000).toFixed(t % 1000 ? 2 : 0)} s` : `${t} ms`);

function Chip({ st, changed }: { st: TcpState; changed: boolean }) {
  return <span className={"lc-chip" + (changed ? " changed" : "") + (st === "ESTABLISHED" ? " est" : st === "CLOSED" ? " closed" : "")}>{st}</span>;
}

function SegArrow({ r, onToggle, dropped, fresh }: { r: Extract<Row, { kind: "seg" }>; onToggle?: () => void; dropped: boolean; fresh: boolean }) {
  const right = r.from === "c";
  const nums = [r.flags.includes("RST") && r.seq === 0 ? null : `seq ${r.seq}`, r.ack !== null ? `ack ${r.ack}` : null, r.len ? `${r.len} B` : null].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="lc-flag">{r.retrans ? "↻ " : ""}{r.flags.filter((f) => f !== "PSH").join("+")}{r.len ? " + data" : ""}</span>
      <span className={"lc-line" + (right ? " right" : " left") + (r.lostBy ? " lost" : "") + (fresh ? " fresh" : "")}><i /></span>
      <span className="lc-nums">{r.lostBy === "firewall" ? "dropped by the firewall" : r.lostBy === "you" ? "lost on its first trip" : nums}</span>
    </>
  );
  if (!onToggle) return <div className="lc-arrow">{body}</div>;
  return (
    <button className={"lc-arrow lc-toggle" + (dropped ? " on" : "")} onClick={onToggle}
      aria-pressed={dropped} title={dropped ? "Click to let it through" : "Click to lose it on its first trip"}
      aria-label={`${LABEL_NAME[r.label]}: ${dropped ? "lost on its first trip" : "delivered"}. Click to toggle.`}>
      {body}
    </button>
  );
}

function Timeline({ r, st, dispatch, reduced }: { r: Result; st: State; dispatch: (a: Action) => void; reduced: boolean }) {
  const shown = r.rows.slice(0, st.cursor);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [st.cursor, reduced]);
  let prev = startStates(st.mode);
  let lastT = 0;
  return (
    <div className="lc-timeline" ref={box}>
      <div className="lc-row lc-headrow" aria-hidden="true">
        <span />
        <span className="label">Client</span>
        <span />
        <span className="label">Database</span>
      </div>
      <div className="lc-row">
        <span className="lc-t">0</span>
        <Chip st={prev.c} changed={false} />
        <span className="lc-gap">{st.cursor === 0 ? "Press Play or Step." : ""}</span>
        <Chip st={prev.s} changed={false} />
      </div>
      {shown.map((row, i) => {
        const t = timeOf(row);
        const gap = t - lastT > 300 ? <div key={`g${row.id}`} className="lc-gaprow">⋯ {ms(t - lastT)} later</div> : null;
        lastT = t;
        const now = rowStates(row);
        const changed = { c: now.c !== prev.c, s: now.s !== prev.s };
        prev = now;
        const fresh = i === shown.length - 1 && !reduced;
        if (row.kind === "note") {
          return [gap, (
            <div key={row.id} className={"lc-note " + row.tone + (row.side === "s" ? " srv" : "")}>
              <span className="lc-t">{ms(t)}</span>
              <p>{row.text}</p>
            </div>
          )];
        }
        const canToggle = DROPPABLE.includes(row.label) && !row.retrans && row.lostBy !== "firewall";
        return [gap, (
          <div key={row.id} className="lc-row">
            <span className="lc-t">{ms(t)}</span>
            <Chip st={now.c} changed={changed.c} />
            <SegArrow r={row} fresh={fresh} dropped={st.drops.includes(row.label)}
              onToggle={canToggle ? () => dispatch({ type: "toggleDrop", label: row.label }) : undefined} />
            <Chip st={now.s} changed={changed.s} />
          </div>
        )];
      })}
    </div>
  );
}

function outcomeLine(r: Result): { head: string; take: string; bad: boolean } {
  const o = r.outcome;
  switch (o.kind) {
    case "ok": {
      const rtts = Math.round(o.connectedAt / (2 * ONE_WAY));
      return {
        head: `connect() returned after ${ms(o.connectedAt)} (${n(rtts, "round trip")}), and the query's rows arrived at ${ms(o.responseAt)}. ${n(r.segments, "segment")} in all, ${r.retransmissions} resent. Then the client sat in TIME-WAIT for ${TIME_WAIT_MS / 1000} s, because it closed first.`,
        take: r.retransmissions
          ? `Each lost segment cost a whole retransmit timer (${INITIAL_RTO / 1000} s here) against a ${2 * ONE_WAY} ms round trip. A lost pure ACK cost nothing when another segment carried the same number.`
          : "Three segments to open, four to close. The connection exists only as state in the two machines; no router on the path knows about it.",
        bad: r.retransmissions > 0,
      };
    }
    case "refused":
      return { head: `connect() failed after ${ms(o.at)} with ECONNREFUSED: the database host's kernel answered the SYN with a RST.`, take: "A closed port is cheap to discover: one round trip. The expensive failures are the silent ones.", bad: false };
    case "reset":
      return { head: `The client sent its query and got a RST back ${ms(o.at)} after connect() began. read() failed with ECONNRESET.`, take: "The server's kernel forgot the connection the moment the process died. The client learned only when the RST arrived, so its error came from read(), not connect(). Whether the query ran is unknown: retry only if it is idempotent.", bad: true };
    case "timeout":
      return o.by === "kernel"
        ? { head: `connect() hung for ${ms(o.at)} while the kernel resent the SYN ${SYN_RETRIES} times, then failed with ETIMEDOUT.`, take: "Silence is the expensive failure. Every request that needs this connection waits two minutes, holding a thread or a goroutine. Set a connect timeout.", bad: true }
        : { head: `Your ${CONNECT_TIMEOUT_MS / 1000} s connect timeout turned the same silence into an error after ${ms(o.at)}.`, take: "The kernel would have kept trying for about two minutes. The application, which knows how long a request may take, should decide when to give up.", bad: false };
  }
}

export default function TcpLifecyclePlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const cfg = configOf(st);
  const r = useMemo(() => simulate(cfg), [cfg.mode, cfg.abort, cfg.timeout, cfg.drops.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const finished = st.cursor >= r.rows.length;

  useEffect(() => {
    if (!playing) return;
    if (finished) { setPlaying(false); return; }
    const id = window.setTimeout(() => dispatch({ type: "next" }), 520);
    return () => window.clearTimeout(id);
  }, [playing, finished, st.cursor, dispatch]);

  const change = (a: Action) => {
    dispatch(a);
    if (reduced) { dispatch({ type: "toEnd" }); setPlaying(false); } else setPlaying(true);
  };
  const play = () => {
    if (reduced) { dispatch({ type: "toEnd" }); return; }
    if (finished) { dispatch({ type: "rewind" }); setPlaying(true); return; }
    setPlaying((p) => !p);
  };

  let cur = startStates(st.mode);
  for (const row of r.rows.slice(0, st.cursor)) cur = rowStates(row);
  const shownT = st.cursor ? timeOf(r.rows[st.cursor - 1]) : 0;
  const out = finished ? outcomeLine(r) : null;
  const o = r.outcome;

  return (
    <PgFrame title="One connection, from SYN to TIME-WAIT" onReset={() => { setPlaying(false); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <PgPredict
        question="A firewall silently drops your SYNs to the database, and your client sets no connect timeout. On Linux, how long until connect() gives up?"
        options={[{ value: "now", label: "At once: connection refused" }, { value: "3s", label: "About 3 seconds" }, { value: "2m", label: "About 2 minutes" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.revealed}
        answer="2m"
        explain={`About two minutes (${SYN_RETRIES} resends at 1, 2, 4, 8, 16 and 32 s, then a final 64 s wait: 127 s). Nothing comes back, so the kernel cannot tell a firewall from a slow network. "Refused" needs a RST, which only arrives when the host answers. Set the server to Firewall drops SYNs and play it to see.`}
      />

      <div className="pg-card">
        <span className="label">The database host</span>
        <PgChoice label="Database host" value={st.mode} options={MODES} onChange={(m) => change({ type: "mode", mode: m })} />
        <label className="lc-check">
          <input type="checkbox" checked={st.abort} onChange={(e) => change({ type: "abort", on: e.target.checked })} />
          The database process crashes when the query arrives (its kernel sends a RST)
        </label>
        <span className="label">The client's connect timeout</span>
        <PgChoice label="Connect timeout" value={st.timeout} options={TIMEOUTS} onChange={(v) => change({ type: "timeout", value: v })} />
        <span className="label">Lose a segment on its first trip · or click an arrow below</span>
        <div className="lc-drops">
          {DROPPABLE.map((l) => (
            <button key={l} className={"lc-drop" + (st.drops.includes(l) ? " on" : "")} aria-pressed={st.drops.includes(l)}
              onClick={() => change({ type: "toggleDrop", label: l })}>{LABEL_NAME[l]}</button>
          ))}
        </div>
      </div>

      <div className="pg-card">
        <div className="lc-now" aria-live="polite">
          <div><span className="label">Client socket</span><b className={cur.c === "ESTABLISHED" ? "est" : ""}>{cur.c}</b></div>
          <div className="lc-clock"><span className="label">t</span><b>{ms(shownT)}</b></div>
          <div><span className="label">Database socket</span><b className={cur.s === "ESTABLISHED" ? "est" : ""}>{cur.s}</b></div>
        </div>
        <div className="pg-actions">
          <PgButton primary onClick={play}>{reduced ? "Run" : playing ? "Pause" : finished ? "Replay" : st.cursor ? "Resume" : "Play"}</PgButton>
          <PgButton onClick={() => { setPlaying(false); dispatch({ type: "next" }); }} disabled={finished}>Step</PgButton>
          <PgButton onClick={() => { setPlaying(false); dispatch({ type: "toEnd" }); }} disabled={finished}>Skip to end</PgButton>
        </div>
        <Timeline r={r} st={st} dispatch={(a) => change(a)} reduced={reduced} />
        <dl className="pg-stats">
          <div className={finished && o.kind !== "ok" ? "bad" : ""}><dt>connect()</dt><dd>{!finished ? "…" : o.kind === "ok" ? `ok · ${ms(o.connectedAt)}` : o.kind === "refused" ? "refused" : o.kind === "reset" ? "ok" : `timeout · ${ms(o.at)}`}</dd></div>
          <div className={finished && o.kind === "reset" ? "bad" : ""}><dt>Query</dt><dd>{!finished ? "…" : o.kind === "ok" ? `rows · ${ms(o.responseAt)}` : o.kind === "reset" ? "ECONNRESET" : "never sent"}</dd></div>
          <div><dt>Segments</dt><dd>{finished ? r.segments : "…"}</dd></div>
          <div className={finished && r.retransmissions ? "bad" : ""}><dt>Resent</dt><dd>{finished ? r.retransmissions : "…"}</dd></div>
        </dl>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="lc-ch">
          {CHALLENGES.map((c) => {
            const ok = st.done.includes(c.id);
            return <li key={c.id} className={ok ? "done" : ""}>{ok ? "✓ " : ""}{c.text}</li>;
          })}
        </ol>
      </div>

      {out && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your connection did</span>
          <p>{out.head}</p>
          <p className="pg-takeaway">{out.take}</p>
        </div>
      )}

      <PgSources links={[
        { title: "the TCP Handshake and Termination MicroSim", href: "https://dmccreary.github.io/networking/sims/tcp-handshake-and-termination/" },
        { title: "NetViz's TCP state machine", href: "https://deep5050.github.io/netviz" },
        { title: "RFC 9293's state diagram", href: "https://www.rfc-editor.org/rfc/rfc9293.html#section-3.3.2" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.lc-check { display: flex; gap: 6px; align-items: flex-start; font-size: .92rem; }
.lc-check input { margin-top: 4px; }
.lc-drops { display: flex; flex-wrap: wrap; gap: 4px; }
.lc-drop { border: 1px solid var(--line); background: var(--surface); padding: 3px 8px; font-size: .78rem; font-family: var(--f-code); }
.lc-drop.on { border-color: var(--pain); background: var(--pain-bg); color: var(--pain); text-decoration: line-through; }
.lc-now { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: end; }
.lc-now > div { display: grid; gap: 2px; }
.lc-now > div:last-child { text-align: right; }
.lc-now b { font-family: var(--f-code); font-size: 1rem; letter-spacing: .02em; transition: color .2s var(--ease); }
.lc-now b.est { color: var(--good); }
.lc-clock { text-align: center; }
.lc-clock b { font-size: .85rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.lc-timeline { max-height: 480px; overflow-y: auto; border: 1px solid var(--line); background-color: var(--surface); padding: 6px;
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 16px 16px; display: grid; gap: 4px; align-content: start; }
.lc-row { display: grid; grid-template-columns: 3.4em 7.6em minmax(0, 1fr) 7.6em; gap: 6px; align-items: center; }
.lc-headrow .label { text-align: center; }
.lc-t { font-family: var(--f-code); font-size: .62rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.lc-chip { font-family: var(--f-code); font-size: .6rem; letter-spacing: .03em; text-align: center; padding: 3px 2px; border: 1px solid var(--line); background: var(--bg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-chip.est { color: var(--good); }
.lc-chip.closed { color: var(--ink-2); }
.lc-chip.changed { border-color: var(--accent); background: var(--hl); color: var(--ink); font-weight: 700; }
.lc-gap { font-size: .8rem; color: var(--ink-2); text-align: center; }
.lc-arrow { display: grid; gap: 1px; justify-items: stretch; text-align: center; min-width: 0; border: 1px solid transparent; background: transparent; padding: 1px 2px; font: inherit; color: inherit; }
.lc-toggle { cursor: pointer; }
.lc-toggle:hover, .lc-toggle:focus-visible { border-color: var(--line); background: var(--bg); }
.lc-toggle.on .lc-flag { color: var(--pain); }
.lc-flag { font-family: var(--f-code); font-size: .7rem; font-weight: 700; color: var(--accent); }
.lc-nums { font-family: var(--f-code); font-size: .56rem; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-line { position: relative; height: 10px; display: block; }
.lc-line i { position: absolute; top: 4px; height: 2px; background: var(--accent); left: 0; right: 0; }
.lc-line.right i::after, .lc-line.left i::after { content: ""; position: absolute; top: -4px; border: 5px solid transparent; }
.lc-line.right i::after { right: -2px; border-left-color: var(--accent); border-right: 0; }
.lc-line.left i::after { left: -2px; border-right-color: var(--accent); border-left: 0; }
.lc-line.lost i { background: var(--pain); }
.lc-line.lost.right i { right: 50%; } .lc-line.lost.left i { left: 50%; }
.lc-line.lost i::after { content: "✕"; border: 0; top: -7px; color: var(--pain); font-size: 12px; }
.lc-line.lost.right i::after { right: -6px; } .lc-line.lost.left i::after { left: -6px; }
.lc-line.fresh.right i { transform-origin: left; animation: lc-grow .35s var(--ease) both; }
.lc-line.fresh.left i { transform-origin: right; animation: lc-grow .35s var(--ease) both; }
@keyframes lc-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.lc-note { display: grid; grid-template-columns: 3.4em minmax(0, 1fr); gap: 6px; align-items: baseline; }
.lc-note p { margin: 0; font-size: .82rem; line-height: 1.35; border-left: 3px solid var(--line); padding: 2px 8px; background: var(--bg); }
.lc-note.srv p { border-left: 0; border-right: 3px solid var(--line); text-align: right; }
.lc-note.ok p { border-color: var(--good); }
.lc-note.bad p { border-color: var(--pain); background: var(--pain-bg); }
.lc-gaprow { font-family: var(--f-code); font-size: .64rem; color: var(--ink-2); text-align: center; letter-spacing: .06em; padding: 4px 0; border-top: 1px dashed var(--line); border-bottom: 1px dashed var(--line); }
.lc-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.lc-ch li.done { color: var(--good); }
@media (max-width: 520px) {
  .lc-row { grid-template-columns: 2.6em 6.2em minmax(0, 1fr) 6.2em; gap: 4px; }
  .lc-note { grid-template-columns: 2.6em minmax(0, 1fr); }
  .lc-chip { font-size: .52rem; }
}
@media (prefers-reduced-motion: reduce) { .lc-line.fresh i { animation: none; } .lc-now b { transition: none; } }
`;
