"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  DEVICES, FOLLOWERS, MAX_LAG, POLICIES, STICKY, WINDOW, applied, behind, init, screen, step,
  type Challenge, type Device, type Node, type Policy, type Read, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const NODE: Record<Node, string> = { leader: "Leader", f1: "Follower 1", f2: "Follower 2" };
const DEV: Record<Device, string> = { laptop: "Laptop", phone: "Phone" };

const RULES: Record<Policy, { label: string; long: string }> = {
  any: { label: "Any replica", long: "The load balancer sends each read to the next follower." },
  window: { label: `Leader for ${WINDOW} s`, long: `Reads go to the leader for ${WINDOW} s after this session's own write, then to any follower.` },
  sticky: { label: "Sticky replica", long: `Each session is pinned to one follower (laptop → follower 1, phone → follower 2).` },
  token: { label: "Version token", long: "The session carries the newest log position it wrote or read. A read goes to a follower that has applied it, else to the leader." },
};

const CHALLENGES: { id: Challenge; title: string; note: string }[] = [
  { id: "vanish", title: "Save, refresh, and see your old name (any replica)", note: "the follower had not applied your write yet" },
  { id: "backwards", title: "See the new name, then the old one again (any replica)", note: "two refreshes hit two followers with different lag" },
  { id: "window", title: `Beat the ${WINDOW}-second leader window`, note: `lag grew past ${WINDOW} s, and the window is a guess about lag` },
  { id: "sticky", title: "Make a sticky session miss its own write", note: "a pinned follower never goes back in time, but it can still be behind" },
  { id: "device", title: "Break version tokens with the second device", note: "the token lived in the laptop's cookie, so the phone had none" },
];

/* ---------------- the space-time timeline ---------------- */

const SPAN = 16;
const LANE: Record<Node, number> = { leader: 36, f1: 86, f2: 136 };
const X0 = 96, W = 600, PX = (W - X0 - 12) / SPAN;

function Timeline({ st, reads }: { st: State; reads: Read[] }) {
  const t0 = Math.max(0, st.t - SPAN + 2);
  const x = (t: number) => X0 + Math.min(SPAN, Math.max(0, t - t0)) * PX;
  const inView = (t: number) => t >= t0 && t <= t0 + SPAN;
  return (
    <svg className="rl-svg" viewBox={`0 0 ${W} 170`} role="img"
      aria-label={`Timeline of the last ${SPAN} seconds: writes on the leader, when each follower applies them, and where each read was served.`}>
      {Array.from({ length: SPAN + 1 }, (_, i) => (
        <g key={i}>
          <line x1={X0 + i * PX} x2={X0 + i * PX} y1={18} y2={156} className="rl-grid" />
          {(t0 + i) % 2 === 0 && <text x={X0 + i * PX} y={166} className="rl-tick">{t0 + i}s</text>}
        </g>
      ))}
      {(Object.keys(LANE) as Node[]).map((node) => (
        <g key={node}>
          <line x1={X0} x2={W - 12} y1={LANE[node]} y2={LANE[node]} className="rl-lane" />
          <text x={4} y={LANE[node] - 4} className="rl-name">{NODE[node]}</text>
          <text x={4} y={LANE[node] + 10} className="rl-sub">
            {node === "leader" ? `at #${applied(st, "leader")}` : `at #${applied(st, node)} · ${behind(st, node)}s behind`}
          </text>
        </g>
      ))}
      {st.entries.map((e) => (
        <g key={e.lsn}>
          {FOLLOWERS.map((f) => (inView(e.t) || inView(e.arrive[f])) && (
            <line key={f} x1={x(e.t)} y1={LANE.leader} x2={x(e.arrive[f])} y2={LANE[f]}
              className={"rl-ship" + (e.arrive[f] > st.t ? " flying" : "")} />
          ))}
          {inView(e.t) && (
            <g>
              <circle cx={x(e.t)} cy={LANE.leader} r={6} className="rl-write" />
              <text x={x(e.t)} y={LANE.leader - 10} className="rl-tick">#{e.lsn}</text>
            </g>
          )}
          {FOLLOWERS.map((f) => inView(e.arrive[f]) && e.arrive[f] <= st.t && (
            <circle key={f} cx={x(e.arrive[f])} cy={LANE[f]} r={3} className="rl-apply" />
          ))}
        </g>
      ))}
      {reads.filter((r) => inView(r.t)).map((r) => (
        <g key={r.id}>
          <rect x={x(r.t) - 7} y={LANE[r.node] - 7} width={14} height={14} className={"rl-read" + (r.ryw || r.mono ? " bad" : "")} />
          <text x={x(r.t)} y={LANE[r.node] + 3.5} className="rl-glyph">{r.device === "laptop" ? "L" : "P"}</text>
        </g>
      ))}
      <line x1={x(st.t)} x2={x(st.t)} y1={14} y2={158} className="rl-now" />
      <text x={x(st.t)} y={11} className="rl-tick rl-nowlabel">now</text>
    </svg>
  );
}

/* ---------------- one device ---------------- */

function DeviceCard({ st, d, dispatch }: { st: State; d: Device; dispatch: (a: import("./model").Action) => void }) {
  const r = st.runs[st.view];
  const sc = screen(st, st.view, d);
  const last = [...r.reads].reverse().find((x) => x.device === d);
  const fresh = last && sc.from !== "save" ? last : null;
  const bad = fresh && (fresh.ryw || fresh.mono);
  return (
    <section className={"pg-side rl-device" + (bad ? " bad" : "")} aria-label={DEV[d]}>
      <header><h4>{DEV[d]}</h4><span className="rl-small muted">profile page</span></header>
      <div className="rl-screen" aria-live="polite">
        <span className="label">Display name</span>
        <b>{sc.value}</b>
        <span className="rl-small">
          {sc.from === "save" ? "just saved" : `from ${NODE[sc.from]}, row #${sc.lsn}`}
          {fresh?.ryw && " · your newest save is missing"}
          {fresh?.mono && " · older than what this device showed before"}
        </span>
      </div>
      <div className="pg-actions">
        <PgButton onClick={() => dispatch({ type: "save", device: d })}>Save new name</PgButton>
        <PgButton primary onClick={() => dispatch({ type: "refresh", device: d })}>Refresh</PgButton>
      </div>
    </section>
  );
}

type Guess = "both-new" | "new-old" | "both-old";

export default function ReplicationLagPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const firstSave = st.entries[0]?.t;
  const after = firstSave === undefined ? 0 : st.runs.any.reads.filter((r) => r.t > firstSave).length;
  const revealed = after >= 2;
  const view = st.runs[st.view];
  const reads = st.runs.any.reads.length;
  const A = st.runs.any, T = st.runs.token;
  const pct = (k: number) => (reads ? Math.round((k / reads) * 100) : 0);

  return (
    <PgFrame title="A leader, two followers and your profile page" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="Follower 1 lags 1 s, follower 2 lags 4 s, and reads go to any follower in turn. On the laptop you save a new name, then refresh twice. What do the two refreshes show?"
        options={[
          { value: "both-new", label: "The new name, twice" },
          { value: "new-old", label: "The new name, then the old one" },
          { value: "both-old", label: "The old name, twice" },
        ]}
        value={guess} onChange={setGuess} revealed={revealed} answer="new-old"
        explain={<>The first refresh hit follower 1, which had applied your save. The second hit follower 2, still 4 s behind, so the name went back. That breaks two promises at once: <b>read-your-writes</b> (you see your own save) and <b>monotonic reads</b> (you never see older data after newer).</>}
      />

      <div className="pg-req">
        <span className="label">Replication lag · drag to break it</span>
        <div className="rl-lags">
          {FOLLOWERS.map((f) => (
            <label key={f} className="rl-lag">
              <span className="pg-place">{NODE[f]} lag</span>
              <input type="range" min={0} max={MAX_LAG} value={st.lags[f]} onChange={(e) => dispatch({ type: "lag", follower: f, seconds: Number(e.target.value) })} />
              <code>{st.lags[f]} s</code>
            </label>
          ))}
        </div>
        <p className="rl-small muted">A new lag applies to the next save. Real lag is usually under a second and grows to seconds or minutes when a follower is busy, catching up, or far away.</p>
      </div>

      <div className="pg-sides">
        {DEVICES.map((d) => <DeviceCard key={d} st={st} d={d} dispatch={dispatch} />)}
      </div>
      <div className="pg-actions">
        <PgButton onClick={() => dispatch({ type: "wait", seconds: 1 })}>Wait 1 s</PgButton>
        <PgButton onClick={() => dispatch({ type: "wait", seconds: 5 })}>Wait 5 s</PgButton>
        <span className="rl-small muted rl-clock">Clock: {st.t} s · every save or refresh takes 1 s</span>
      </div>

      <div className="pg-req">
        <span className="label">Route reads with</span>
        <PgChoice<Policy> label="Read routing rule" value={st.view} onChange={(p) => dispatch({ type: "view", policy: p })}
          options={POLICIES.map((p) => ({ value: p, label: RULES[p].label, note: RULES[p].long }))} />
        <p className="rl-small">{RULES[st.view].long}</p>
        {(st.view === "window" || st.view === "token") && (
          <label className="rl-check">
            <input type="checkbox" checked={st.perUser} onChange={(e) => dispatch({ type: "perUser", on: e.target.checked })} />
            <span>Keep the {st.view === "token" ? "token" : "last-write time"} on the server per user, not in each device's cookie</span>
          </label>
        )}
        <Timeline st={st} reads={view.reads} />
        <p className="rl-small muted">Dots on the leader are saves (#row). Lines show each follower applying them; dashed lines are still in flight. Squares are refreshes from the laptop (L) or phone (P), on the node that served them. Orange means a broken promise. {st.view === "sticky" && `Pins: laptop → ${NODE[STICKY.laptop]}, phone → ${NODE[STICKY.phone]}.`}</p>
      </div>

      <div className="pg-req">
        <span className="label">The same session under every rule</span>
        <table className="rl-table">
          <thead><tr><th>Rule</th><th>Own save missing</th><th>Went backwards</th><th>Leader reads</th></tr></thead>
          <tbody>
            {POLICIES.map((p) => {
              const r = st.runs[p];
              return (
                <tr key={p} className={p === st.view ? "on" : ""}>
                  <th><button className="rl-link" onClick={() => dispatch({ type: "view", policy: p })} aria-pressed={p === st.view}>{RULES[p].label}</button></th>
                  <td className={r.ryw ? "bad" : ""}>{r.ryw}</td>
                  <td className={r.mono ? "bad" : ""}>{r.mono}</td>
                  <td>{r.leaderReads} <span className="muted">({pct(r.leaderReads)}%)</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pg-req">
        <span className="label">Break it: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="rl-list">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      {st.entries.length > 0 && reads >= 2 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your session showed</span>
          <p>
            You saved {n(st.entries.length, "time")} and refreshed {n(reads, "time")}. With any-replica routing, your own save was missing {n(A.ryw, "time")} and the page went backwards {n(A.mono, "time")}.
            {" "}With version tokens the same traffic broke {n(T.ryw + T.mono, "promise")}, and {pct(T.leaderReads)}% of reads fell back to the leader.
          </p>
          <p className="pg-takeaway">
            Asynchronous followers show the past. Which past depends on which follower you hit. Pinning a session to one follower stops time going backwards; only knowing how far the session has already seen (a token) and reading from a node that has caught up to it gives you your own writes too, and only if the token follows the user to every device.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Kleppmann's DDIA chapter on replication lag", href: "https://dataintensive.net/" },
        { title: "Jepsen's consistency model map", href: "https://jepsen.io/consistency" },
        { title: "Terry et al., Session Guarantees for Weakly Consistent Replicated Data (1994)", href: "https://www.cs.cornell.edu/courses/cs734/2000FA/cached%20papers/SessionGuaranteesPDIS_1.html" },
      ]} />

      <style>{`
        .rl-small { font-size: .88rem; margin: 0; }
        .rl-lags { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 16px; }
        .rl-lag { display: grid; grid-template-columns: 9em minmax(0, 1fr) 3em; gap: 8px; align-items: center; }
        .rl-lag input { width: 100%; accent-color: var(--accent); }
        .rl-device.bad { border-color: var(--pain); }
        .rl-screen { border: 1px solid var(--line); background: var(--surface); padding: 8px 10px; display: grid; gap: 2px; }
        .rl-screen b { font-size: 1.15rem; }
        .rl-device.bad .rl-screen { background: var(--pain-bg); }
        .rl-device.bad .rl-screen .rl-small { color: var(--pain); }
        .rl-clock { align-self: center; }
        .rl-check { display: flex; gap: 8px; align-items: flex-start; font-size: .9rem; }
        .rl-svg { width: 100%; height: auto; display: block; border: 1px solid var(--line); background: var(--surface); }
        .rl-grid { stroke: var(--line); stroke-width: .5; }
        .rl-lane { stroke: var(--ink-2); stroke-width: 1; }
        .rl-name { font-family: var(--f-code); font-size: 9px; letter-spacing: .06em; text-transform: uppercase; fill: var(--ink); }
        .rl-sub { font-family: var(--f-code); font-size: 8px; fill: var(--ink-2); }
        .rl-tick { font-family: var(--f-code); font-size: 8px; fill: var(--ink-2); text-anchor: middle; }
        .rl-nowlabel { fill: var(--accent); }
        .rl-now { stroke: var(--accent); stroke-width: 1.5; }
        .rl-ship { stroke: var(--accent); stroke-width: 1; opacity: .7; }
        .rl-ship.flying { stroke-dasharray: 3 3; }
        .rl-write { fill: var(--accent); }
        .rl-apply { fill: var(--accent); }
        .rl-read { fill: var(--good-bg); stroke: var(--good); stroke-width: 1.2; ${reduced ? "" : "transition: fill .2s var(--ease);"} }
        .rl-read.bad { fill: var(--pain-bg); stroke: var(--pain); }
        .rl-glyph { font-family: var(--f-code); font-size: 8px; text-anchor: middle; fill: var(--ink); }
        .rl-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
        .rl-table th, .rl-table td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; font-variant-numeric: tabular-nums; }
        .rl-table thead th { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
        .rl-table tr.on { background: var(--surface); }
        .rl-table td.bad { color: var(--pain); font-weight: 600; }
        .rl-link { border: 0; background: none; padding: 0; text-align: left; font: inherit; color: var(--ink); text-decoration: underline; text-decoration-color: var(--line); }
        .rl-table tr.on .rl-link { color: var(--accent); font-weight: 600; }
        .rl-list { list-style: none; padding-left: 0 !important; }
        .rl-list li.got { color: var(--good); }
        @media (max-width: 520px) { .rl-lag { grid-template-columns: 1fr 3em; } .rl-lag .pg-place { grid-column: 1 / -1; } }
      `}</style>
    </PgFrame>
  );
}
