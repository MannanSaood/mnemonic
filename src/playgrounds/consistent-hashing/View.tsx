"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, KEYS, KEY_HASH, MIN_SERVERS, NAMES, RING, VNODES,
  busiest, init, lastChange, loads, modOwners, nextServer, ringOwners, ringPoints, step,
  type Change, type Server, type State, type Vnodes,
} from "./model";

const pct = (k: number) => `${Math.round((k / KEYS) * 100)}%`;
const colour = (s: Server) => `ch-s${NAMES.indexOf(s)}`;
const short = (s: Server) => s.slice(-1).toUpperCase();
const C = 150;
const polar = (pos: number, r: number) => {
  const a = (pos / RING) * 2 * Math.PI - Math.PI / 2;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};

function Ring({ st, owners, change, reduced }: { st: State; owners: Server[]; change: Change | null; reduced: boolean }) {
  const pts = ringPoints(st.servers, st.vnodes);
  return (
    <svg viewBox="0 0 300 300" className="ch-ring" role="img"
      aria-label={`Hash ring with ${st.servers.length} servers, ${st.vnodes} points each, and ${KEYS} keys coloured by the server that owns them.`}>
      <circle cx={C} cy={C} r={124} className="ch-track" />
      {KEY_HASH.map((h, i) => {
        const [x, y] = polar(h, 96 + (i % 6) * 4.5);
        const moved = change?.ringMoved[i];
        return <circle key={i} cx={x} cy={y} r={moved ? 2.6 : 1.7} className={`ch-key ${colour(owners[i])}${moved ? " ch-moved" : ""}${reduced ? "" : " anim"}`} />;
      })}
      {pts.map((p, j) => {
        const [x1, y1] = polar(p.pos, 128), [x2, y2] = polar(p.pos, st.vnodes > 50 ? 134 : 140);
        return <line key={j} x1={x1} y1={y1} x2={x2} y2={y2} className={`ch-pt ${colour(p.server)}`} />;
      })}
      {st.vnodes <= 3 && pts.map((p, j) => {
        const [x, y] = polar(p.pos, 150);
        return <text key={j} x={x} y={y + 3} textAnchor="middle" className={`ch-lbl ${colour(p.server)}`}>{short(p.server)}</text>;
      })}
      <text x={C} y={C - 4} textAnchor="middle" className="ch-mid">{KEYS} keys</text>
      <text x={C} y={C + 10} textAnchor="middle" className="ch-mid sub">{st.servers.length} servers × {st.vnodes} pt{st.vnodes > 1 ? "s" : ""}</text>
    </svg>
  );
}

function Grid({ moved, label }: { moved: boolean[] | null; label: string }) {
  const cols = 40, cell = 6;
  return (
    <svg viewBox={`0 0 ${cols * cell} ${(KEYS / cols) * cell}`} className="ch-grid" role="img" aria-label={label}>
      {Array.from({ length: KEYS }, (_, i) => (
        <rect key={i} x={(i % cols) * cell} y={Math.floor(i / cols) * cell} width={cell - 1} height={cell - 1}
          className={moved?.[i] ? "ch-cell moved" : "ch-cell"} />
      ))}
    </svg>
  );
}

function describe(c: Change) {
  if (c.kind === "add") return `${c.server} joined (${c.from} → ${c.to} servers)`;
  if (c.kind === "remove") return `${c.server} died (${c.from} → ${c.to} servers)`;
  return `points per server changed to ${c.vnodes}`;
}

function Result({ st, c }: { st: State; c: Change }) {
  const ratio = busiest(st.servers, ringOwners(st.servers, st.vnodes));
  const ideal = c.kind === "add" ? Math.round(KEYS / c.to) : c.kind === "remove" ? Math.round(KEYS / c.from) : null;
  const dest = Object.entries(c.ringTo).sort((a, b) => b[1] - a[1]);
  const lines: string[] = [];
  lines.push(`When ${describe(c)}, hash % N sent ${c.modCount} of ${KEYS} keys (${pct(c.modCount)}) to a different server: ${c.modCount} cache misses landing on the database at once. The ring moved ${c.ringCount} (${pct(c.ringCount)})${ideal ? `; the minimum any scheme can do is about ${ideal}` : ""}.`);
  let take: string;
  if (c.kind === "vnodes") take = "Changing the number of points reshuffles the ring itself, so pick it before you have data on it. Watch the busiest server's share instead.";
  else if (c.kind === "add" && c.ringCount < 0.6 * (ideal ?? 0))
    take = `The ring moved few keys, but only because ${c.server} landed on a small arc: it got ${c.ringCount} keys while the busiest server holds ${ratio.toFixed(2)}× a fair share. One point per server makes uneven arcs. Raise the points per server.`;
  else if (c.kind === "remove" && dest.length === 1)
    take = `All ${c.ringCount} of ${c.server}'s keys went to ${dest[0][0]}, its clockwise neighbour, which now has to absorb the whole load. With many points per server, a dead server's keys spread over every survivor.`;
  else if (c.kind === "remove")
    take = `${c.server}'s keys spread over ${dest.length} survivors (${dest.map(([s, k]) => `${s} ${k}`).join(", ")}), because its points sat between many different servers' points. No key that lived elsewhere moved.`;
  else take = `Every key that moved went to ${c.server}; no key moved between the old servers. With hash % N, ${c.modCount - c.ringCount} keys moved between servers that did not change at all.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What this change cost</span>
      <p>{lines.join(" ")}</p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function ConsistentHashingPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const ring = ringOwners(st.servers, st.vnodes);
  const mod = modOwners(st.servers);
  const ringLoad = loads(st.servers, ring), modLoad = loads(st.servers, mod);
  const fair = KEYS / st.servers.length;
  const c = lastChange(st);
  const firstAdd = [...st.changes].reverse().find((x) => x.kind === "add");
  const ratio = busiest(st.servers, ring);
  const next = nextServer(st);
  const maxLoad = Math.max(...st.servers.map((s) => Math.max(ringLoad[s], modLoad[s])), fair * 1.5);

  return (
    <PgFrame title="A cache fleet, 1,000 keys" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="Four cache servers hold 1,000 keys, placed with hash(key) % 4. Add a fifth server and switch to % 5. How many keys now belong to a different server?"
        options={[{ value: "200", label: "About 200" }, { value: "500", label: "About 500" }, { value: "800", label: "About 800" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={!!firstAdd}
        answer="800"
        explain={<>{firstAdd ? `${firstAdd.modCount} moved. ` : ""}A key stays only if hash % 4 equals hash % 5, which holds for 4 of every 20 hash values. So 80% move, and each move is a cache miss. On the ring, only the keys in the arcs the new server takes move.</>}
      />

      <div className="pg-grid ch-top">
        <div className="pg-card">
          <span className="label">The ring · each key belongs to the next server point clockwise</span>
          <Ring st={st} owners={ring} change={c} reduced={reduced} />
        </div>
        <div className="pg-card">
          <span className="label">Servers · keys held (ring / hash % N)</span>
          <ul className="ch-servers">
            {st.servers.map((s) => (
              <li key={s}>
                <span className={`ch-sw ${colour(s)}`} aria-hidden="true">{short(s)}</span>
                <span className="ch-name">{s}</span>
                <span className="ch-bars" aria-label={`${s}: ${ringLoad[s]} keys on the ring, ${modLoad[s]} with modulo`}>
                  <i className={`ch-bar ${colour(s)}`} style={{ width: `${(ringLoad[s] / maxLoad) * 100}%` }} />
                  <i className="ch-bar mod" style={{ width: `${(modLoad[s] / maxLoad) * 100}%` }} />
                  <i className="ch-fair" style={{ left: `${(fair / maxLoad) * 100}%` }} />
                </span>
                <span className="ch-num">{ringLoad[s]} / {modLoad[s]}</span>
                <button className="pg-btn ch-kill" onClick={() => dispatch({ type: "remove", server: s })}
                  disabled={st.servers.length <= MIN_SERVERS} title={`Take ${s} out: it crashed`}>Kill</button>
              </li>
            ))}
          </ul>
          <p className="ch-note">The tick on each bar is a fair share ({Math.round(fair)} keys). Top bar: ring. Grey bar: hash % N.</p>
          <div className="pg-actions">
            <PgButton primary onClick={() => dispatch({ type: "add" })} disabled={!next}>{next ? `+ Add ${next}` : "Fleet is full"}</PgButton>
          </div>
          <span className="ch-k">Points per server (virtual nodes)</span>
          <PgChoice<string> label="Points per server" value={String(st.vnodes)}
            onChange={(v) => dispatch({ type: "vnodes", vnodes: Number(v) as Vnodes })}
            options={VNODES.map((v) => ({ value: String(v), label: String(v) }))} />
        </div>
      </div>

      <div className="pg-card">
        <span className="label">{c ? `Change ${c.id}: ${describe(c)} · each square is a key, orange ones changed server` : "Keys that change server · add or kill a server to see"}</span>
        <div className="pg-sides">
          <div className="pg-side">
            <header><h4>hash % N</h4><span className={"pg-status" + (c && c.modCount < 0.4 * KEYS ? " done" : "")}>{c ? `${c.modCount} moved · ${pct(c.modCount)}` : "waiting"}</span></header>
            <Grid moved={c?.modMoved ?? null} label={c ? `${c.modCount} of ${KEYS} keys moved with modulo hashing` : "No change yet"} />
          </div>
          <div className="pg-side">
            <header><h4>Hash ring</h4><span className={"pg-status" + (c && c.ringCount < 0.4 * KEYS ? " done" : "")}>{c ? `${c.ringCount} moved · ${pct(c.ringCount)}` : "waiting"}</span></header>
            <Grid moved={c?.ringMoved ?? null} label={c ? `${c.ringCount} of ${KEYS} keys moved on the ring` : "No change yet"} />
          </div>
        </div>
        <dl className="pg-stats">
          <div><dt>Servers</dt><dd>{st.servers.length}</dd></div>
          <div><dt>Points on ring</dt><dd>{st.servers.length * st.vnodes}</dd></div>
          <div className={ratio > 1.5 ? "bad" : ""}><dt>Busiest · ring</dt><dd>{ratio.toFixed(2)}× fair</dd></div>
          <div><dt>Busiest · % N</dt><dd>{busiest(st.servers, mod).toFixed(2)}× fair</dd></div>
        </dl>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="ch-ch">
          {CHALLENGES.map((x) => (
            <li key={x.id} className={st.done[x.id] ? "done" : ""}>{st.done[x.id] ? "✓ " : ""}{x.text}</li>
          ))}
        </ol>
      </div>

      {c && <Result st={st} c={c} />}

      <PgSources links={[
        { title: "Dennis Chowitz's interactive Consistent Hashing Explained", href: "https://dev.to/dchowitz/consistent-hashing-explained-ol0" },
        { title: "Karger et al., Consistent Hashing and Random Trees (STOC 1997)", href: "https://dl.acm.org/doi/10.1145/258533.258660" },
        { title: "the OpenStack Swift ring background", href: "https://docs.openstack.org/swift/latest/ring_background.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.ch-top { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.ch-ring { width: 100%; max-width: 340px; height: auto; justify-self: center; display: block; background: var(--surface); border: 1px solid var(--line); }
.ch-track { fill: none; stroke: var(--line); stroke-width: 1; }
.ch-key { stroke: none; }
.ch-key.anim { transition: fill .4s var(--ease), r .3s var(--ease); }
.ch-key.ch-moved { stroke: var(--ink); stroke-width: .7; }
.ch-pt { stroke-width: 2; }
.ch-lbl { font-family: var(--f-code); font-size: 10px; font-weight: 700; }
.ch-mid { font-family: var(--f-code); font-size: 11px; fill: var(--ink); text-transform: uppercase; letter-spacing: .05em; }
.ch-mid.sub { font-size: 9px; fill: var(--ink-2); }
.ch-s0 { --c: var(--accent); } .ch-s1 { --c: var(--pain); } .ch-s2 { --c: var(--good); } .ch-s3 { --c: var(--shiki-token-constant); }
.ch-s4 { --c: var(--ink); } .ch-s5 { --c: color-mix(in srgb, var(--pain) 50%, var(--shiki-token-constant)); }
.ch-s6 { --c: color-mix(in srgb, var(--good) 45%, var(--ink-2)); } .ch-s7 { --c: var(--ink-2); }
.ch-key, .ch-lbl { fill: var(--c); } .ch-pt { stroke: var(--c); }
.ch-servers { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ch-servers li { display: grid; grid-template-columns: 1.4em 4.6em minmax(0, 1fr) 4.6em auto; gap: 6px; align-items: center; }
.ch-sw { display: inline-grid; place-items: center; width: 1.4em; height: 1.4em; background: var(--c); color: var(--bg); font-family: var(--f-code); font-size: .7rem; font-weight: 700; }
.ch-name { font-family: var(--f-code); font-size: .74rem; }
.ch-bars { position: relative; display: grid; gap: 2px; min-width: 0; }
.ch-bar { display: block; height: 7px; background: var(--c); transition: width .35s var(--ease); }
.ch-bar.mod { background: var(--line); height: 4px; }
.ch-fair { position: absolute; top: -2px; bottom: -2px; width: 0; border-left: 1.5px dashed var(--ink); }
.ch-num { font-family: var(--f-code); font-size: .7rem; font-variant-numeric: tabular-nums; text-align: right; }
.ch-kill { padding: 1px 7px; font-size: .74rem; color: var(--pain); }
.ch-note { margin: 0; font-size: .82rem; color: var(--ink-2); }
.ch-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.ch-grid { width: 100%; height: auto; display: block; }
.ch-cell { fill: var(--surface-2); transition: fill .3s var(--ease); }
.ch-cell.moved { fill: var(--pain); }
.ch-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.ch-ch li.done { color: var(--good); }
@media (max-width: 700px) { .ch-top { grid-template-columns: 1fr; } }
@media (max-width: 420px) { .ch-servers li { grid-template-columns: 1.4em minmax(0, 1fr) 4.4em auto; } .ch-name { display: none; } }
@media (prefers-reduced-motion: reduce) { .ch-key.anim, .ch-bar, .ch-cell { transition: none; } }
`;
