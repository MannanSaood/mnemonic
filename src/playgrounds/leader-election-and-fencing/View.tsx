"use client";
import { useEffect, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel, type PgLogEntry } from "../kit";
import {
  FIRST_TOKEN, PAUSES, TICK, TTL, WORKERS,
  init, secs, staleAccepted, staleRejected, step,
  type Action, type Challenge, type Guess, type PauseLen, type State, type Store, type WId,
} from "./model";

const WINDOW = 40_000;
const W = 560, LX = 78;
const Y = { lock: 34, a: 86, b: 132, plain: 188, fenced: 234 };
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

const SPEEDS = [
  { value: "250", label: "1×" },
  { value: "100", label: "2.5×" },
  { value: "50", label: "5×" },
];

const CHALLENGES: { id: Challenge; title: string; note: string }[] = [
  { id: "short", title: "Pause the leader for less than its lease", note: "it wakes, renews and nobody noticed" },
  { id: "stale", title: "Pause the leader past its lease and let it write", note: "plain storage took the zombie's write over newer data; fenced storage refused it" },
  { id: "second", title: "Pause the new leader too", note: "the token rose again, and the old token is now the stale one" },
];

function Timeline({ st }: { st: State }) {
  const t0 = Math.max(0, st.now - WINDOW + 4_000);
  const x = (t: number) => LX + ((t - t0) / WINDOW) * (W - LX - 10);
  const clip = (t: number | null) => x(Math.max(t0, Math.min(t ?? st.now, st.now)));
  const visible = (from: number, to: number | null) => (to ?? st.now) >= t0;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / 5_000) * 5_000; t <= st.now; t += 5_000) ticks.push(t);
  const laneY = (who: WId) => (who === 0 ? Y.a : Y.b);
  const holder = st.lock.holder;
  return (
    <svg viewBox={`0 0 ${W} 262`} className="fe-svg" role="img"
      aria-label={`Timeline of the last ${WINDOW / 1000} seconds at t = ${secs(st.now)}. Lease ${holder === null ? "free" : `held by ${WORKERS[holder]} with token ${st.lock.token}`}. Worker A ${st.workers[0].pausedUntil ? "paused" : st.workers[0].role}, worker B ${st.workers[1].pausedUntil ? "paused" : st.workers[1].role}. ${staleAccepted(st)} stale writes accepted by plain storage, ${staleRejected(st)} rejected by fenced storage.`}>
      <defs>
        <pattern id="fe-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" className="fe-hatch-bg" /><line x1="0" y1="0" x2="0" y2="6" className="fe-hatch-line" />
        </pattern>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={16} y2={248} className="fe-grid" />
          <text x={x(t)} y={258} className="fe-tick">{t / 1000}s</text>
        </g>
      ))}
      {([["lock", "LOCK"], ["a", "WORKER A"], ["b", "WORKER B"], ["plain", "STORE"], ["fenced", "FENCED"]] as const).map(([k, label]) => (
        <g key={k}>
          <line x1={LX} x2={W - 10} y1={Y[k]} y2={Y[k]} className="fe-lane" />
          <text x={4} y={Y[k] + 4} className="fe-name">{label}</text>
        </g>
      ))}
      {st.holds.filter((h) => visible(h.from, h.to)).map((h, i) => (
        <g key={i}>
          <rect x={clip(h.from)} y={Y.lock - 9} width={Math.max(0, clip(h.to) - clip(h.from))} height={18} className={`fe-hold w${h.holder}`} />
          <text x={clip(h.from) + 4} y={Y.lock + 4} className={`fe-holdt w${h.holder}`}>{WORKERS[h.holder]} · {h.token}</text>
        </g>
      ))}
      {st.segs.filter((g) => visible(g.from, g.to)).map((g, i) => {
        const x1 = clip(g.from), x2 = clip(g.to), y = laneY(g.who);
        if (g.kind === "standby") return <line key={i} x1={x1} x2={x2} y1={y} y2={y} className="fe-standby" />;
        return (
          <g key={i}>
            <rect x={x1} y={y - 9} width={Math.max(0, x2 - x1)} height={18} className={g.kind === "paused" ? "fe-paused" : `fe-lead w${g.who}`} />
            {g.kind === "paused" && x2 - x1 > 44 && <text x={x1 + 4} y={y + 4} className="fe-pt">GC PAUSE</text>}
          </g>
        );
      })}
      {st.writes.filter((w) => w.at >= t0).map((w) => {
        const xx = x(w.at);
        const p = st.plain.log.find((r) => r.write === w.id)!;
        const f = st.fenced.log.find((r) => r.write === w.id)!;
        return (
          <g key={w.id}>
            <line x1={xx} x2={xx} y1={laneY(w.by) + 9} y2={Y.fenced} className={"fe-w" + (p.stale ? " bad" : "")} />
            <circle cx={xx} cy={Y.plain} r={p.stale ? 5 : 3} className={"fe-dot w" + w.by + (p.stale ? " bad" : "")} />
            {f.accepted
              ? <circle cx={xx} cy={Y.fenced} r={3} className={"fe-dot w" + w.by} />
              : <text x={xx} y={Y.fenced + 4} className="fe-x">✗</text>}
            {p.stale && <text x={xx + 6} y={Y.plain - 7} className="fe-bad">{w.token} over {Math.max(...st.writes.filter((o) => o.at <= w.at).map((o) => o.token))}</text>}
          </g>
        );
      })}
      <line x1={x(st.now)} x2={x(st.now)} y1={14} y2={248} className="fe-now" />
      <text x={W - 10} y={12} className="fe-clock">t = {secs(st.now)}</text>
    </svg>
  );
}

function StoreCard({ st, s, title, fenced }: { st: State; s: Store; title: string; fenced: boolean }) {
  const v = s.value === null ? null : st.writes.find((w) => w.id === s.value)!;
  const bad = fenced ? s.log.filter((r) => !r.accepted).length : s.log.filter((r) => r.stale).length;
  return (
    <section className={"pg-side fe-store" + (!fenced && bad ? " hurt" : "")} aria-label={title}>
      <header><h4>{title}</h4></header>
      <p className="fe-small">{fenced ? `Rejects a token below ${s.highest || "the highest seen"}.` : "Accepts every write."}</p>
      <p className="fe-small">Latest export: {v ? <b>batch {v.batch} by {WORKERS[v.by]} (token {v.token})</b> : "none yet"}</p>
      <p className={"fe-small" + (bad ? (fenced ? " good" : " pain") : "")}>
        {fenced ? `${n(bad, "stale write")} rejected` : `${n(bad, "stale write")} accepted over newer data`}
      </p>
    </section>
  );
}

export default function FencingPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("100");
  useEffect(() => { setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches); }, []);
  useEffect(() => {
    if (!playing) return;
    const h = window.setInterval(() => dispatch({ type: "tick", ms: TICK }), Number(speed));
    return () => window.clearInterval(h);
  }, [playing, speed, dispatch]);

  const act = (a: Action) => dispatch(a);
  const L = st.lock;
  const entries: PgLogEntry[] = st.marks.slice(-6).reverse().map((m, i) => ({
    id: st.marks.length - i, ok: !m.bad, text: m.text, path: [secs(m.t), m.who === null ? "lock" : WORKERS[m.who]],
  }));
  const accepted = staleAccepted(st), rejected = staleRejected(st);

  const toolbar = (
    <>
      <PgButton onClick={() => setPlaying((p) => !p)}>{playing ? "Pause clock" : "Play"}</PgButton>
      <PgButton onClick={() => act({ type: "tick", ms: 1_000 })} disabled={playing}>+1 s</PgButton>
      <PgChoice label="Speed" value={speed} options={SPEEDS} onChange={setSpeed} />
    </>
  );

  return (
    <PgFrame title="A lock service, two workers, two kinds of storage" onReset={() => act({ type: "reset" })} toolbar={toolbar}>
      <PgPredict<Guess>
        question={`Worker A holds a ${TTL / 1000} s lease. It checks the lease, renders its export, and freezes in a 15 s GC pause just before sending it. Meanwhile B takes the lease. When A wakes, what happens to that write?`}
        options={[
          { value: "rejected", label: "The lock service rejects it" },
          { value: "overwrites", label: "Storage accepts it over B's newer export" },
          { value: "notices", label: "A sees its lease expired and drops it" },
        ]}
        value={st.prediction} onChange={(v) => act({ type: "predict", value: v })} revealed={st.done.includes("stale")} answer="overwrites"
        explain={<>The write never goes through the lock service, and A already did its check, before the pause. To A no time has passed. Storage that accepts any write takes it over B's. Storage that remembers the highest token it has seen sees {FIRST_TOKEN} after {FIRST_TOKEN + 1} and refuses.</>}
      />

      <div className="pg-card">
        <span className="label">The last {WINDOW / 1000} seconds · every write goes to both stores</span>
        <Timeline st={st} />
        <span className="fe-legend"><i className="w0" />A leads <i className="w1" />B leads <i className="ps" />paused <b>✗</b> rejected by token</span>
      </div>

      <div className="fe-row">
        <PgChoice label="GC pause length" value={String(st.pauseLen)} options={PAUSES.map((p) => ({ value: String(p), label: `${p / 1000} s pause`, note: p < TTL ? "shorter than the lease" : "longer than the lease" }))}
          onChange={(v) => act({ type: "setPause", ms: Number(v) as PauseLen })} />
      </div>

      <div className="fe-cards">
        <section className="pg-side" aria-label="Lock service">
          <header><h4>Lock service</h4></header>
          <p className="fe-small">{L.holder === null ? <b>Lease free</b> : <>Lease: <b>{WORKERS[L.holder]}, token {L.token}</b>, {secs(Math.max(0, L.expires - st.now))} left</>}</p>
          <p className="fe-small muted">Each grant raises the token. Renewal every 3 s keeps it alive.</p>
        </section>
        {([0, 1] as WId[]).map((who) => {
          const w = st.workers[who];
          const paused = w.pausedUntil !== null;
          const zombie = w.role === "leader" && (L.holder !== who || L.token !== w.token);
          return (
            <section key={who} className={"pg-side fe-worker" + (zombie ? " zombie" : "")} aria-label={`Worker ${WORKERS[who]}`}>
              <header><h4>Worker {WORKERS[who]}</h4></header>
              <p className="fe-small">
                {paused ? <>Frozen for {secs(w.pausedUntil! - st.now)} more, batch {w.pending?.batch} in hand</> : w.role === "leader" ? <>Leader, token {w.token}</> : "Standby, polling the lock"}
              </p>
              <p className={"fe-small" + (zombie ? " pain" : " muted")}>
                {w.role === "leader" ? (zombie ? `Believes it leads. It does not: ${L.holder === null ? "the lease expired" : `${WORKERS[L.holder]} holds ${L.token}`}.` : `Believes its lease runs to ${secs(w.leaseSeenUntil)}.`) : "Not leading."}
              </p>
              <PgButton primary={w.role === "leader" && !paused} disabled={w.role !== "leader" || paused} onClick={() => act({ type: "pause", who })}
                title="Stop the world: the worker freezes just before its next write">GC pause {WORKERS[who]} ({st.pauseLen / 1000} s)</PgButton>
            </section>
          );
        })}
        <StoreCard st={st} s={st.plain} title="Storage, no fencing" fenced={false} />
        <StoreCard st={st} s={st.fenced} title="Storage with fencing tokens" fenced />
      </div>

      <PgLog entries={entries} empty="Press Play, then pause the leader." reduced={reduced} />

      <div className="pg-req">
        <span className="label">Find it: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="fe-list">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      {st.pauses > 0 && st.now > 12_000 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your run did</span>
          <p>
            In {secs(st.now)} you paused a leader {n(st.pauses, "time")} and the lock service issued {n(L.token - FIRST_TOKEN + 1, "token")}. For {secs(st.overlap)} two workers each believed they were the leader.
            {" "}Storage without fencing accepted {n(accepted, "stale write")} over newer data; storage with fencing rejected {n(rejected, "stale write")}.
          </p>
          <p className="pg-takeaway">
            {accepted > 0
              ? "A lease cannot stop a holder that does not know time has passed. The check ran before the pause, so it passed. The only place that sees both writes is the storage, so that is where the token must be compared: higher wins, lower is refused."
              : "A pause shorter than the lease is harmless: the holder renews on waking. Make one longer than the lease and watch who notices."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Martin Kleppmann, How to do distributed locking (2016)", href: "https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html" },
        { title: "Jepsen's etcd 3.4.3 analysis of locks and leases", href: "https://jepsen.io/analyses/etcd-3.4.3" },
        { title: "client-go's leaderelection package docs", href: "https://pkg.go.dev/k8s.io/client-go/tools/leaderelection" },
      ]} />

      <style>{`
        .fe-svg { display: block; width: 100%; height: auto; background: var(--surface); border: 1px solid var(--line); }
        .fe-grid { stroke: var(--line); stroke-dasharray: 2 4; }
        .fe-tick, .fe-clock { font-family: var(--f-code); font-size: 8px; fill: var(--ink-2); text-anchor: middle; }
        .fe-clock { text-anchor: end; font-size: 9px; }
        .fe-lane { stroke: var(--line); }
        .fe-name { font-family: var(--f-code); font-size: 8.5px; font-weight: 700; fill: var(--ink); letter-spacing: .04em; }
        .fe-hold.w0, .fe-lead.w0 { fill: var(--accent); }
        .fe-hold.w1, .fe-lead.w1 { fill: var(--ink); }
        .fe-holdt { font-family: var(--f-code); font-size: 9px; font-weight: 700; }
        .fe-holdt.w0 { fill: var(--accent-ink); }
        .fe-holdt.w1 { fill: var(--bg); }
        .fe-standby { stroke: var(--ink-2); stroke-width: 2; stroke-dasharray: 3 3; }
        .fe-paused { fill: url(#fe-hatch); stroke: var(--pain); }
        .fe-hatch-bg { fill: var(--pain-bg); }
        .fe-hatch-line { stroke: var(--pain); stroke-width: 2; }
        .fe-pt { font-family: var(--f-code); font-size: 8px; font-weight: 700; fill: var(--pain); }
        .fe-w { stroke: var(--line); stroke-width: 1; }
        .fe-w.bad { stroke: var(--pain); stroke-width: 1.5; }
        .fe-dot.w0 { fill: var(--accent); }
        .fe-dot.w1 { fill: var(--ink); }
        .fe-dot.bad { fill: var(--pain); }
        .fe-x { font-family: var(--f-code); font-size: 12px; font-weight: 700; fill: var(--pain); text-anchor: middle; }
        .fe-bad { font-family: var(--f-code); font-size: 8px; fill: var(--pain); }
        .fe-now { stroke: var(--accent); stroke-width: 1.5; }
        .fe-legend { font-size: .78rem; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
        .fe-legend i { display: inline-block; width: 14px; height: 8px; margin-right: 3px; vertical-align: middle; }
        .fe-legend i.w0 { background: var(--accent); }
        .fe-legend i.w1 { background: var(--ink); }
        .fe-legend i.ps { background: var(--pain-bg); border: 1px solid var(--pain); }
        .fe-legend b { color: var(--pain); }
        .fe-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        .fe-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
        .fe-small { font-size: .85rem; margin: 0; }
        .fe-small.pain { color: var(--pain); }
        .fe-small.good { color: var(--good); }
        .fe-worker.zombie, .fe-store.hurt { border-color: var(--pain); }
        .fe-list { list-style: none; padding-left: 0 !important; }
        .fe-list li.got { color: var(--good); }
      `}</style>
    </PgFrame>
  );
}
