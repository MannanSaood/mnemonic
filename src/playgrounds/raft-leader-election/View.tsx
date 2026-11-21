"use client";
import { useEffect, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, MAJORITY, N, TIMEOUT_LABEL,
  challengeDone, init, maxTerm, name, sideSize, step, usableLeader,
  type Msg, type Partition, type Server, type State, type TimeoutMode,
} from "./model";

const CX = 180, CY = 150, R = 108;
const pos = (id: number) => {
  const a = -Math.PI / 2 + (id * 2 * Math.PI) / N;
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
};
const SPEEDS = [
  { value: "2", label: "0.05×" },
  { value: "4", label: "0.1×" },
  { value: "10", label: "0.25×" },
];
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Link({ a, b, cut }: { a: number; b: number; cut: boolean }) {
  const p = pos(a), q = pos(b);
  return (
    <g>
      <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={"raft-link" + (cut ? " cut" : "")} />
      {cut && <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 + 4} textAnchor="middle" className="raft-x">✗</text>}
    </g>
  );
}

function Node({ x, st, onToggle }: { x: Server; st: State; onToggle: () => void }) {
  const p = pos(x.id);
  const frac = x.role === "leader" || !x.alive ? 0 : Math.max(0, x.timer / x.timeout);
  const C = 2 * Math.PI * 37;
  const minority = x.alive && sideSize(st, x.id) < MAJORITY;
  return (
    <g className={`raft-node ${x.alive ? x.role : "dead"}${minority ? " minority" : ""}`} onClick={onToggle} aria-hidden="true">
      {x.alive && x.role !== "leader" && (
        <circle cx={p.x} cy={p.y} r={37} className="raft-timer" strokeDasharray={`${C * frac} ${C}`} transform={`rotate(-90 ${p.x} ${p.y})`} />
      )}
      <circle cx={p.x} cy={p.y} r={30} className="raft-body" />
      <text x={p.x} y={p.y - 6} textAnchor="middle" className="raft-name">{name(x.id)}</text>
      <text x={p.x} y={p.y + 7} textAnchor="middle" className="raft-term">{x.alive ? `term ${x.term}` : "down"}</text>
      <text x={p.x} y={p.y + 18} textAnchor="middle" className="raft-sub">
        {!x.alive ? "" : x.role === "leader" ? "leader" : x.role === "candidate" ? `${x.votes.length}/${MAJORITY} votes` : x.votedFor !== null ? `voted ${name(x.votedFor)}` : "no vote yet"}
      </text>
    </g>
  );
}

function Message({ m, now }: { m: Msg; now: number }) {
  const p = pos(m.from), q = pos(m.to);
  const f = Math.min(1, Math.max(0, (now - m.sentAt) / (m.deliverAt - m.sentAt)));
  const x = p.x + (q.x - p.x) * f, y = p.y + (q.y - p.y) * f;
  const cls = m.kind === "vote-req" ? "req" : m.kind === "vote" ? (m.granted ? "yes" : "no") : m.kind === "append" ? "hb" : "ack";
  const r = m.kind === "append" || m.kind === "append-reply" ? 3 : 5;
  return <circle cx={x} cy={y} r={r} className={`raft-msg ${cls}`} />;
}

function Cluster({ st, dispatch, reduced }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void; reduced: boolean }) {
  const links: [number, number][] = [];
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) links.push([a, b]);
  const toggle = (x: Server) => dispatch(x.alive ? { type: "kill", id: x.id } : { type: "revive", id: x.id });
  const leader = usableLeader(st);
  return (
    <svg viewBox="0 0 360 300" className="raft-svg" role="img"
      aria-label={`Five servers. ${st.servers.map((x) => `${name(x.id)} ${x.alive ? x.role : "down"} term ${x.term}`).join("; ")}. ${leader ? `${name(leader.id)} leads.` : "No usable leader."}`}>
      {links.map(([a, b]) => <Link key={`${a}-${b}`} a={a} b={b} cut={st.servers[a].side !== st.servers[b].side} />)}
      {!reduced && st.msgs.map((m) => <Message key={m.id} m={m} now={st.now} />)}
      {st.servers.map((x) => <Node key={x.id} x={x} st={st} onToggle={() => toggle(x)} />)}
      <text x={6} y={14} className="raft-clock">t = {st.now} ms</text>
      <text x={354} y={14} textAnchor="end" className="raft-clock">{leader ? `leader ${name(leader.id)} · term ${leader.term}` : "no usable leader"}</text>
      {reduced && <text x={6} y={294} className="raft-clock">{st.msgs.length} messages in flight</text>}
    </svg>
  );
}

function Result({ st }: { st: State }) {
  if (st.now < 300 || st.elections < 2) return null;
  const fo = st.failovers;
  let takeaway: string;
  if (st.mode === "fixed" && st.splitVotes > 2)
    takeaway = "With identical timeouts, every follower stands at the same moment, votes for itself, and nobody reaches three. They all time out together again, so it repeats. Randomness that is larger than a message's travel time breaks the tie.";
  else if (st.flags.deposed)
    takeaway = "The old leader never knew it had lost its majority. It kept its term, and stepped down only when a message with a higher term reached it. The term number, not the clock, decided who was current.";
  else if (st.flags.minorityClimb)
    takeaway = "The side with two servers kept timing out and starting elections with ever higher terms, but two votes are not three. A minority can never elect a leader, so there is never a second leader on the wrong side. When the network heals, those inflated terms can force one needless election; Pre-Vote exists to stop that.";
  else if (st.flags.noQuorum)
    takeaway = "Two servers can each vote for themselves forever and never reach three. Five servers tolerate two failures; the third failure stops elections until one comes back.";
  else
    takeaway = "Each server votes once per term, and a winner needs three of five votes, so a term can have at most one leader. The random timeouts decide who usually asks first.";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your cluster did</span>
      <p>
        In {(st.now / 1000).toFixed(1)} s of cluster time there {st.elections - 1 === 1 ? "was 1 election" : `were ${st.elections - 1} elections`} after the first, reaching term {maxTerm(st)}, with {n(st.splitVotes, "split vote")}.
        {fo.length ? ` New leaders took over after ${fo.map((x) => `${x} ms`).join(", ")}.` : ""}
        {` The cluster had no leader a majority could reach for ${st.leaderless} ms.`}
      </p>
      <p className="pg-takeaway">{takeaway}</p>
    </div>
  );
}

export default function RaftElectionPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("4");
  // Run in slow motion by default; readers who prefer reduced motion start paused and step.
  useEffect(() => { setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches); }, []);
  useEffect(() => {
    if (!playing) return;
    const h = window.setInterval(() => dispatch({ type: "tick", ms: Number(speed) }), 40);
    return () => window.clearInterval(h);
  }, [playing, speed, dispatch]);

  const leader = usableLeader(st);
  const toolbar = (
    <>
      <PgButton onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</PgButton>
      <PgButton onClick={() => dispatch({ type: "tick", ms: 25 })} disabled={playing}>+25 ms</PgButton>
      <PgChoice label="Speed" value={speed} options={SPEEDS} onChange={setSpeed} />
    </>
  );

  return (
    <PgFrame title="Five servers electing a leader" onReset={() => { dispatch({ type: "reset" }); }} toolbar={toolbar}>
      <style>{CSS}</style>
      <PgPredict
        question="The network splits into 2 and 3 servers, with the leader on the side of 2. What happens?"
        options={[
          { value: "new", label: "The 3 elect a new leader; the old one keeps leading its side" },
          { value: "stepdown", label: "The old leader notices and steps down at once" },
          { value: "none", label: "Nobody can lead until the network heals" },
        ]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.flags.twoLeaders}
        answer="new"
        explain="The side with three servers times out, and one of them wins three votes in a higher term. The old leader hears nothing that tells it otherwise, so it carries on in its old term. With only two servers it can never commit a write (the next lesson), and it steps down the moment it sees the higher term."
      />

      <div className="pg-grid raft-grid">
        <div className="pg-card">
          <span className="label">The cluster · click a server to crash or restart it</span>
          <Cluster st={st} dispatch={dispatch} reduced={reduced} />
          <span className="raft-legend"><i className="req" />vote request <i className="yes" />vote granted <i className="no" />vote refused <i className="hb" />heartbeat · ring = election timer</span>
        </div>
        <div className="pg-card">
          <span className="label">Break it</span>
          <div className="raft-servers">
            {st.servers.map((x) => (
              <PgButton key={x.id} onClick={() => dispatch(x.alive ? { type: "kill", id: x.id } : { type: "revive", id: x.id })}>
                {x.alive ? `Crash ${name(x.id)}` : `Restart ${name(x.id)}`}{x.alive && x.role === "leader" ? " (leader)" : ""}
              </PgButton>
            ))}
          </div>
          <span className="raft-k">Network</span>
          <PgChoice<Partition> label="Network" value={st.partition} onChange={(k) => dispatch({ type: "partition", kind: k })}
            options={[
              { value: "none", label: "Connected" },
              { value: "leader-in-minority", label: "Split · leader with 2" },
              { value: "leader-in-majority", label: "Split · leader with 3" },
            ]} />
          <span className="raft-k">Election timeout</span>
          <PgChoice<TimeoutMode> label="Election timeout" value={st.mode} onChange={(m) => dispatch({ type: "setMode", mode: m })}
            options={(["wide", "narrow", "fixed"] as TimeoutMode[]).map((m) => ({ value: m, label: TIMEOUT_LABEL[m] }))} />
          <p className="raft-note">Heartbeat every 50 ms. Messages take 15–21 ms. A winner needs {MAJORITY} of {N} votes.</p>
          <dl className="pg-stats">
            <div><dt>Term</dt><dd>{maxTerm(st)}</dd></div>
            <div><dt>Elections</dt><dd>{st.elections - 1}</dd></div>
            <div className={st.splitVotes ? "bad" : ""}><dt>Split votes</dt><dd>{st.splitVotes}</dd></div>
            <div className={leader ? "" : "bad"}><dt>Leaderless</dt><dd>{st.leaderless} ms</dd></div>
          </dl>
          <span className="label">What happened · newest first</span>
          <div className="pg-log raft-log" aria-live="polite">
            {st.log.map((e, i) => (
              <div key={e.n} className={"pg-entry" + (e.tone === "bad" ? " fail" : "") + (e.tone === "info" ? " raft-info" : "") + (i === 0 && !reduced ? " fresh" : "")}>
                <p><span className="raft-t">{e.t} ms</span> {e.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="raft-ch">
          {CHALLENGES.map((c) => (
            <li key={c.id} className={challengeDone(st, c.id) ? "done" : ""}>{challengeDone(st, c.id) ? "✓ " : ""}{c.text}</li>
          ))}
        </ol>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "The Secret Lives of Data: Raft", href: "http://thesecretlivesofdata.com/raft/" },
        { title: "RaftScope on raft.github.io", href: "https://raft.github.io/" },
        { title: "the Raft paper (Ongaro and Ousterhout)", href: "https://raft.github.io/raft.pdf" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.raft-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); }
.raft-svg { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.raft-link { stroke: var(--line); stroke-width: 1; }
.raft-link.cut { stroke: var(--pain); stroke-dasharray: 3 4; opacity: .7; }
.raft-x { font-family: var(--f-code); font-size: 10px; fill: var(--pain); }
.raft-node { cursor: pointer; }
.raft-body { fill: var(--bg); stroke: var(--ink-2); stroke-width: 1.5; transition: fill .2s, stroke .2s; }
.raft-node.candidate .raft-body { fill: var(--pain-bg); stroke: var(--pain); stroke-width: 2; }
.raft-node.leader .raft-body { fill: var(--accent); stroke: var(--accent); stroke-width: 3; }
.raft-node.leader text { fill: var(--accent-ink); }
.raft-node.dead .raft-body { fill: var(--surface-2); stroke-dasharray: 4 3; }
.raft-node.dead text { fill: var(--ink-2); }
.raft-node.minority .raft-body { stroke: var(--pain); }
.raft-timer { fill: none; stroke: var(--accent); stroke-width: 3; opacity: .55; }
.raft-node.candidate .raft-timer { stroke: var(--pain); }
.raft-name { font-family: var(--f-code); font-size: 11px; font-weight: 700; fill: var(--ink); }
.raft-term { font-family: var(--f-code); font-size: 9px; fill: var(--ink); }
.raft-sub { font-family: var(--f-code); font-size: 7.5px; fill: var(--ink-2); }
.raft-msg.req { fill: var(--pain); }
.raft-msg.yes { fill: var(--good); }
.raft-msg.no { fill: var(--ink-2); }
.raft-msg.hb { fill: var(--accent); opacity: .7; }
.raft-msg.ack { fill: var(--ink-2); opacity: .3; }
.raft-clock { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.raft-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.raft-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 3px; vertical-align: -1px; }
.raft-legend i.req { background: var(--pain); }
.raft-legend i.yes { background: var(--good); }
.raft-legend i.no { background: var(--ink-2); }
.raft-legend i.hb { background: var(--accent); }
.raft-servers { display: flex; flex-wrap: wrap; gap: 6px; }
.raft-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.raft-note { margin: 0; font-size: .85rem; color: var(--ink-2); }
.raft-log { max-height: 220px; }
.raft-info { border-left-color: var(--accent); }
.raft-t { font-family: var(--f-code); font-size: .66rem; color: var(--ink-2); }
.raft-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.raft-ch li.done { color: var(--good); }
@media (max-width: 720px) { .raft-grid { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .raft-body { transition: none; } }
`;
