"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  NAMES, NEW_IP, NS_TIMEOUT_MS, OLD_IP, SERVER_INFO, TTLS,
  authLoadPerHour, goals, init, liveCache, staleWindow, step, truth,
  type Lookup, type Name, type Server, type State, type Ttl,
} from "./model";

const LANES: { id: "app" | "res" | Server; label: string; sub: string }[] = [
  { id: "app", label: "app", sub: "stub" },
  { id: "res", label: "resolver", sub: "recursive" },
  { id: "root", label: "root", sub: "." },
  { id: "com", label: ".com", sub: "TLD" },
  { id: "net", label: ".net", sub: "TLD" },
  { id: "excom", label: "example.com", sub: "authoritative" },
  { id: "exnet", label: "example.net", sub: "authoritative" },
];

const clock = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h} h ` : ""}${h || m ? `${m} min ` : ""}${sec} s`;
};
const dur = (s: number) => (s >= 3600 ? `${Math.round(s / 360) / 10} h` : s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`);
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

/* ---------------- the sequence diagram of one lookup ---------------- */

function Sequence({ l, reduced }: { l: Lookup; reduced: boolean }) {
  const W = 640, LW = W / LANES.length, top = 40, row = 30;
  const lx = (id: string) => LANES.findIndex((x) => x.id === id) * LW + LW / 2;
  const rows = l.steps.length + 1;
  const H = top + rows * row + 10;
  return (
    <svg className="dns-seq" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Lookup of ${l.name}: ${n(l.queries, "query", "queries")} from the resolver, ${l.totalMs} ms in total.`}>
      {LANES.map((ln) => (
        <g key={ln.id}>
          <text className="dns-lane" x={lx(ln.id)} y={14} textAnchor="middle">{ln.label}</text>
          <text className="dns-lane-sub" x={lx(ln.id)} y={26} textAnchor="middle">{ln.sub}</text>
          <line className="dns-life" x1={lx(ln.id)} x2={lx(ln.id)} y1={32} y2={H - 4} />
        </g>
      ))}
      {l.steps.map((s, i) => {
        const y = top + i * row + 12;
        const delay = reduced ? undefined : { animationDelay: `${i * 160}ms` };
        if (s.kind === "stub") {
          return (
            <g key={i} className={"dns-row" + (reduced ? "" : " anim")} style={delay}>
              <line className="dns-arrow" x1={lx("app")} x2={lx("res") - 4} y1={y} y2={y} markerEnd="url(#dns-ah)" />
              <text className="dns-lbl" x={(lx("app") + lx("res")) / 2} y={y - 4} textAnchor="middle">{s.ms} ms</text>
            </g>
          );
        }
        if (s.kind === "hit") {
          return (
            <g key={i} className={"dns-row" + (reduced ? "" : " anim")} style={delay}>
              <rect className="dns-hit" x={lx("res") - 34} y={y - 10} width={68} height={16} />
              <text className="dns-lbl hit" x={lx("res")} y={y + 2} textAnchor="middle">cache hit</text>
            </g>
          );
        }
        const to = lx(s.server!);
        const fail = s.kind === "timeout";
        return (
          <g key={i} className={"dns-row" + (reduced ? "" : " anim")} style={delay}>
            <line className={"dns-arrow" + (fail ? " fail" : "")} x1={lx("res")} x2={to - 4} y1={y - 4} y2={y - 4} markerEnd="url(#dns-ah)" />
            {!fail && <line className="dns-arrow back" x1={to} x2={lx("res") + 4} y1={y + 6} y2={y + 6} markerEnd="url(#dns-ah)" />}
            {fail && <text className="dns-lbl fail" x={to} y={y + 1} textAnchor="middle">✕</text>}
            <text className={"dns-lbl" + (fail ? " fail" : "")} x={(lx("res") + to) / 2} y={y - 8} textAnchor="middle">
              {fail ? `no reply · ${s.ms} ms` : `${s.kind === "referral" ? "referral" : s.kind === "cname" ? "CNAME" : "answer"} · ${s.ms} ms`}
            </text>
          </g>
        );
      })}
      <g className={"dns-row" + (reduced ? "" : " anim")} style={reduced ? undefined : { animationDelay: `${l.steps.length * 160}ms` }}>
        <line className="dns-arrow back" x1={lx("res")} x2={lx("app") + 4} y1={top + l.steps.length * row + 12} y2={top + l.steps.length * row + 12} markerEnd="url(#dns-ah)" />
        <text className={"dns-lbl" + (l.stale ? " fail" : " ok")} x={(lx("app") + lx("res")) / 2 + 30} y={top + l.steps.length * row + 8} textAnchor="start">
          {l.answer}{l.stale ? " (stale)" : ""} · {l.totalMs} ms total
        </text>
      </g>
      <defs>
        <marker id="dns-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="dns-ahead" />
        </marker>
      </defs>
    </svg>
  );
}

/* ---------------- the resolver's cache ---------------- */

function Cache({ st }: { st: State }) {
  const live = liveCache(st);
  if (!live.length) return <p className="pg-empty">Empty. Every lookup starts at the root.</p>;
  return (
    <div className="dns-cache" role="region" aria-label="Resolver cache" tabIndex={0}>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Left</th></tr></thead>
        <tbody>
          {live.map((e) => {
            const stale = e.type === "A" && e.value !== truth(st, e.key);
            return (
              <tr key={e.key + e.type} className={stale ? "stale" : ""}>
                <td>{e.key === "com" || e.key === "net" ? `.${e.key}` : e.key}</td>
                <td>{e.type}</td>
                <td>{e.type === "NS" ? SERVER_INFO[e.value as Server].label : e.value}{stale ? " ✗ old" : ""}</td>
                <td>{dur(e.expires - st.now)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- the reader's own result ---------------- */

function Result({ st }: { st: State }) {
  const ls = [...st.lookups].reverse();
  if (!ls.length) return null;
  const cold = ls.filter((l) => l.queries > 0), warm = ls.filter((l) => l.queries === 0);
  const avg = (xs: Lookup[]) => Math.round(xs.reduce((s, x) => s + x.totalMs, 0) / xs.length);
  const lines: string[] = [];
  lines.push(`You made ${n(ls.length, "lookup")}. ${cold.length ? `The ${n(cold.length, "one")} that left the resolver averaged ${avg(cold)} ms` : "None left the resolver"}${warm.length ? `; the ${n(warm.length, "cache hit")} averaged ${avg(warm)} ms` : ""}. The root was asked ${n(st.counts.root, "time")}.`);
  const w = staleWindow(st);
  if (st.move && w !== null)
    lines.push(st.move.hadCache
      ? `When you moved api.example.com, your resolver held the old address with ${dur(w)} still to run. Every app behind it gets ${st.apiIp === NEW_IP ? OLD_IP : NEW_IP} until then, whatever the zone says. ${w <= 60 ? "You kept that window short by lowering the TTL first and waiting out the old one." : "Lower the TTL first, wait for the old TTL to run out, then move."}`
      : "When you moved api.example.com no resolver had it cached, so the change was visible at once. In production some resolver always has it cached.");
  const stale = ls.filter((l) => l.stale).length;
  if (stale) lines.push(`${n(stale, "answer")} you got pointed at an address the zone no longer uses.`);
  return <p className="pg-takeaway">{lines.join(" ")}</p>;
}

/* ---------------- the playground ---------------- */

type G1 = "3" | "1" | "0";

export default function DnsResolution() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [g1, setG1] = useState<G1 | null>(null);
  const [g2, setG2] = useState<G1 | null>(null);
  const l = st.lookups[0];
  const g = goals(st);
  const warmHit = st.lookups.find((x) => x.queries === 0);
  const reveal1 = !!warmHit;
  const wwwLookup = st.lookups.find((x) => x.name === "www.example.com");
  const reveal2 = reveal1 && !!wwwLookup;
  const queries = Object.values(st.counts).reduce((a, b) => a + b, 0);
  const reset = () => { setG1(null); setG2(null); dispatch({ type: "reset" }); };

  return (
    <PgFrame title="A recursive resolver, from cold" onReset={reset}>
      <PgPredict<G1>
        question="The resolver's cache is empty. You resolve api.example.com, wait 10 s, and resolve it again. How many queries leave the resolver the second time?"
        options={[{ value: "3", label: "3: root, .com, example.com again" }, { value: "1", label: "1: just example.com" }, { value: "0", label: "0" }]}
        value={g1} onChange={setG1} revealed={reveal1} answer="0"
        explain={<>The answer came with TTL {warmHit ? st.apiTtl : 3600} s, and the resolver keeps it that long. The second lookup took {warmHit?.totalMs ?? 2} ms: the trip from your app to the resolver and back, nothing more.</>}
      />
      {reveal1 && (
        <PgPredict<G1>
          question="Now resolve www.example.com. The resolver has never seen that name, but it is in the same zone. How many queries leave the resolver?"
          options={[{ value: "3", label: "3: a new name walks from the root" }, { value: "1", label: "1" }, { value: "0", label: "0" }]}
          value={g2} onChange={setG2} revealed={reveal2} answer="1"
          explain={<>It took {wwwLookup ? n(wwwLookup.queries, "query", "queries") : "one query"}{wwwLookup && wwwLookup.queries !== 1 ? " (the cache had expired or been flushed; try it straight after an api lookup)" : ""}. The referrals from the root and from .com were cached too, for two days. The resolver went straight to example.com&apos;s own server. That is why the root servers see a tiny share of all lookups.</>}
        />
      )}

      <div className="dns-controls">
        <div className="pg-actions" aria-label="Resolve a name">
          <span className="label">Resolve</span>
          {NAMES.map((name) => (
            <PgButton key={name} primary={name === "api.example.com"} onClick={() => dispatch({ type: "resolve", name: name as Name })}>{name}</PgButton>
          ))}
        </div>
        <div className="pg-actions" aria-label="Let time pass">
          <span className="label">Clock · {clock(st.now)}</span>
          <PgButton onClick={() => dispatch({ type: "wait", seconds: 10 })}>+10 s</PgButton>
          <PgButton onClick={() => dispatch({ type: "wait", seconds: 300 })}>+5 min</PgButton>
          <PgButton onClick={() => dispatch({ type: "wait", seconds: 3600 })}>+1 h</PgButton>
        </div>
      </div>

      <div className="dns-grid">
        <div className="dns-panel">
          <span className="label">{l ? `Lookup ${l.id} · ${l.name} at ${clock(l.at)}` : "Latest lookup"}</span>
          {l ? <Sequence key={l.id} l={l} reduced={reduced} /> : <p className="pg-empty">Answer the question, then resolve api.example.com.</p>}
          {l && (
            <ol className="dns-steps">
              {l.steps.map((s, i) => <li key={i} className={s.kind}>{s.label}{s.ms ? ` · ${s.ms} ms` : ""}</li>)}
            </ol>
          )}
        </div>
        <div className="dns-panel">
          <span className="label">Resolver cache</span>
          <Cache st={st} />
        </div>
      </div>

      <div className="pg-actions dns-break" aria-label="Change the zone and break things">
        <span className="label">api.example.com TTL</span>
        <PgChoice<`${Ttl}`> label="TTL for api.example.com" value={`${st.apiTtl}` as `${Ttl}`}
          options={TTLS.map((t) => ({ value: `${t}` as `${Ttl}`, label: dur(t) }))}
          onChange={(v) => dispatch({ type: "ttl", ttl: Number(v) as Ttl })} />
        <PgButton onClick={() => dispatch({ type: "move" })}>Move api to {st.apiIp === OLD_IP ? NEW_IP : OLD_IP}</PgButton>
        <PgButton onClick={() => dispatch({ type: "flush" })}>Flush cache</PgButton>
        <button className="pg-btn dns-toggle" aria-pressed={st.ns1Down} onClick={() => dispatch({ type: "ns1" })}>{st.ns1Down ? "✓ " : ""}ns1.example.com down</button>
      </div>
      {st.note && <p className="dns-note" aria-live="polite">{st.note}</p>}

      <dl className="pg-stats">
        <div><dt>Lookups</dt><dd>{st.lookups.length ? st.lookups[0].id : 0}</dd></div>
        <div><dt>Queries sent</dt><dd>{queries}</dd></div>
        <div><dt>Root asked</dt><dd>{st.counts.root}</dd></div>
        <div><dt>Last lookup</dt><dd>{l ? `${l.totalMs} ms` : "–"}</dd></div>
        <div className={st.lookups.some((x) => x.stale) ? "bad" : ""}><dt>Stale answers</dt><dd>{st.lookups.filter((x) => x.stale).length}</dd></div>
        <div><dt>api is now</dt><dd>{st.apiIp}</dd></div>
        <div><dt>Load on your NS</dt><dd>{authLoadPerHour(st.apiTtl)} q/h per resolver</dd></div>
        <div className={st.ns1Down ? "bad" : ""}><dt>ns1 timeout</dt><dd>{st.ns1Down ? `${NS_TIMEOUT_MS} ms` : "–"}</dd></div>
      </dl>

      {l && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your lookups show</span>
          <Result st={st} />
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="dns-goals">
          <li className={g.warm ? "done" : ""}>{g.warm ? "✓" : "○"} Get an answer without the resolver sending a single query.</li>
          <li className={g.referral ? "done" : ""}>{g.referral ? "✓" : "○"} Resolve a name the resolver has never seen with exactly one query.</li>
          <li className={g.outage ? "done" : ""}>{g.outage ? "✓" : "○"} Resolve api.example.com while ns1.example.com is down. What did it cost?</li>
          <li className={g.migrate ? "done" : ""}>{g.migrate ? "✓" : "○"} Move api.example.com while it is cached, with at most 60 s of stale answers. You start at TTL 1 h.</li>
        </ul>
      </div>

      <PgSources links={[
        { title: "Julia Evans's DNS trace tool", href: "https://dns-lookup.jvns.ca/trace.html" },
        { title: "Mess With DNS", href: "https://messwithdns.net/" },
        { title: "the How DNS Works comic", href: "https://howdns.works/" },
      ]} />

      <style>{`
        .dns-controls { display: grid; gap: 8px; }
        .dns-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 12px; align-items: start; }
        .dns-panel { border: 1px solid var(--line); background: var(--bg); padding: 8px; display: grid; gap: 6px; min-width: 0; }
        .dns-seq { width: 100%; height: auto; display: block; }
        .dns-lane { font-family: var(--f-code); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; fill: var(--ink); }
        .dns-lane-sub { font-family: var(--f-code); font-size: 8.5px; fill: var(--ink-2); }
        .dns-life { stroke: var(--line); stroke-dasharray: 2 3; }
        .dns-arrow { stroke: var(--accent); stroke-width: 1.6; }
        .dns-arrow.back { stroke: var(--ink-2); stroke-dasharray: 4 3; }
        .dns-arrow.fail { stroke: var(--pain); }
        .dns-ahead { fill: var(--ink-2); }
        .dns-lbl { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
        .dns-lbl.fail { fill: var(--pain); } .dns-lbl.ok { fill: var(--good); } .dns-lbl.hit { fill: var(--good); }
        .dns-hit { fill: var(--good-bg); stroke: var(--good); }
        .dns-row.anim { animation: pg-hop .3s var(--ease) both; }
        .dns-steps { margin: 0; padding-left: 1.4em; font-family: var(--f-code); font-size: .72rem; display: grid; gap: 2px; }
        .dns-steps li.hit { color: var(--good); } .dns-steps li.timeout { color: var(--pain); }
        .dns-cache { overflow-x: auto; }
        .dns-cache table { border-collapse: collapse; width: 100%; font-size: .74rem; font-family: var(--f-code); }
        .dns-cache th, .dns-cache td { border: 1px solid var(--line); padding: 3px 5px; text-align: left; white-space: nowrap; }
        .dns-cache th { font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .dns-cache tr.stale td { color: var(--pain); background: var(--pain-bg); }
        .dns-note { margin: 0; font-size: .9rem; border-left: 3px solid var(--accent); padding-left: 8px; }
        .dns-toggle[aria-pressed="true"] { border-color: var(--pain); color: var(--pain); background: var(--pain-bg); }
        .dns-goals { list-style: none; padding-left: 0 !important; }
        .dns-goals li.done { color: var(--good); }
        @media (max-width: 720px) { .dns-grid { grid-template-columns: minmax(0, 1fr); } }
        @media (prefers-reduced-motion: reduce) { .dns-row.anim { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
