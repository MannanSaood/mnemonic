"use client";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, DB_CAPACITY, LOAD_TICKS, PATTERNS, PATTERN_JOB, PATTERN_NAME, READS_PER_S, SECONDS, TICK_MS, TTLS,
  challengeDone, coalesces, describe, init, shownRun, step,
  type Config, type Invalidate, type Pattern, type Run, type Ttl,
} from "./model";

const W = 600, PAD = 28;
const x = (t: number) => PAD + (t / SECONDS) * (W - PAD - 6);
const BW = (W - PAD - 6) / SECONDS - 1;
const n = (k: number, one: string, many = one + "s") => `${k.toLocaleString("en")} ${k === 1 ? one : many}`;
const pct = (a: number, b: number) => `${((a / Math.max(1, b)) * 100).toFixed(1)}%`;

function writeTimes(run: Run): number[] {
  return run.log.filter((e) => e.path[0] === "writer").map((e) => e.t / 10);
}

function QueryChart({ run, reduced }: { run: Run; reduced: boolean }) {
  const h = 150, top = 18, bottom = h - 14;
  const max = Math.max(DB_CAPACITY * 1.4, ...run.seconds.map((s) => s.queries));
  const y = (v: number) => bottom - (Math.min(v, max) / max) * (bottom - top);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="cs-chart" role="img"
      aria-label={`Database queries per second. Peak ${run.summary.peakQueries} at ${run.summary.peakAt} s; comfortable capacity ${DB_CAPACITY}.`}>
      {writeTimes(run).map((t, i) => (
        <g key={i}><line x1={x(t)} x2={x(t)} y1={6} y2={bottom} className="cs-write" /><text x={x(t) + 3} y={14} className="cs-tiny">write</text></g>
      ))}
      {run.seconds.map((s) => s.queries > 0 && (
        <rect key={s.t} x={x(s.t)} y={y(s.queries)} width={BW} height={Math.max(1, bottom - y(s.queries))}
          className={s.queries > DB_CAPACITY ? "cs-q over" : "cs-q"} />
      ))}
      <line x1={PAD} x2={W - 6} y1={y(DB_CAPACITY)} y2={y(DB_CAPACITY)} className="cs-cap" />
      <text x={W - 8} y={y(DB_CAPACITY) - 3} textAnchor="end" className="cs-tiny">DB comfortable ({DB_CAPACITY}/s)</text>
      <g className="cs-axis">
        <line x1={PAD} y1={bottom} x2={W - 6} y2={bottom} />
        {[0, 10, 20, 30, 40].map((t) => <text key={t} x={x(t)} y={h - 3} textAnchor="middle">{t}s</text>)}
        <text x={PAD - 3} y={top + 4} textAnchor="end">{Math.round(max)}</text>
        <text x={PAD - 3} y={bottom - 2} textAnchor="end">0</text>
      </g>
      {!reduced && <rect key={run.id} x={PAD} y={0} width={W - PAD} height={bottom} className="cs-sweep" />}
    </svg>
  );
}

function FreshStrip({ run }: { run: Run }) {
  const h = 34;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="cs-chart" role="img"
      aria-label={`Seconds in which the cache held an older price than the database: ${run.seconds.filter((s) => s.staleCache).length}.`}>
      <text x={PAD - 3} y={18} textAnchor="end" className="cs-tiny">cache</text>
      {run.seconds.map((s) => <rect key={s.t} x={x(s.t)} y={6} width={BW} height={16} className={s.staleCache ? "cs-old" : "cs-ok"} />)}
      {writeTimes(run).map((t, i) => <line key={i} x1={x(t)} x2={x(t)} y1={2} y2={26} className="cs-write" />)}
      <g className="cs-axis">{[0, 10, 20, 30, 40].map((t) => <text key={t} x={x(t)} y={h - 1} textAnchor="middle">{t}s</text>)}</g>
    </svg>
  );
}

function Result({ run }: { run: Run }) {
  const m = run.summary, c = run.config;
  const served = m.reads;
  let take: string;
  if (m.raced && m.longestStale > 1)
    take = `The race. A refill read the old price, the write changed the database and invalidated the key, and then the refill stored the old price anyway. Nothing else touches the key until its TTL runs out, so readers got an outdated price for ${m.longestStale.toFixed(1)} s. Leases close it: a fill is refused if the key was invalidated after the fill began.`;
  else if (m.raced)
    take = "The race happened, but the herd healed it: readers who missed after the invalidation loaded the new price and overwrote the old one a moment later. Turn on single-flight (or use read-through) and run again. The fix for the herd makes the race stick.";
  else if (m.refused > 0)
    take = `The lease refused ${n(m.refused, "stale fill")}. The next reader missed, loaded the new price, and the cache never served the old one.`;
  else if (m.stale > 0 && c.pattern !== "write-through" && c.invalidate === "ttl")
    take = `With TTL-only invalidation, every write left the cache serving the old price until the entry expired: ${n(m.stale, "stale read")}, the longest stretch ${m.longestStale.toFixed(1)} s. A longer TTL means fewer misses and longer staleness. Delete the key on write.`;
  else if (m.peakQueries >= DB_CAPACITY)
    take = `A thundering herd. For the ${LOAD_TICKS * TICK_MS} ms it takes to load the row, every reader that arrives misses and goes to the database itself: ${m.peakQueries} queries in one second for one row, against a hit ratio of ${pct(m.hits, served)}. Single-flight loads or an early refresh turn that into one query.`;
  else
    take = `Fresh and calm: ${n(m.queries, "database query", "database queries")} for ${served.toLocaleString("en")} reads, no stale reads. Now break it: switch on the second write during a refill.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What these 40 seconds cost</span>
      <p>
        With {describe(c)}: {served.toLocaleString("en")} reads, a hit ratio of {pct(m.hits, served)}, {n(m.queries, "database query", "database queries")} (peak {m.peakQueries} in one second), and {n(m.stale, "stale read")}.
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function CachingPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const c = st.config;
  const run = shownRun(st);
  const set = (patch: Partial<Config>) => dispatch({ type: "set", patch });
  const first = st.runs[st.runs.length - 1];

  return (
    <PgFrame title="A price, a cache and a database, 40 seconds" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question={`A product's price is read ${READS_PER_S} times a second from a cache with a 5 s TTL. Loading it from the database takes ${LOAD_TICKS * TICK_MS} ms. With plain cache-aside, how many database queries does one expiry cause?`}
        options={[{ value: "1", label: "1" }, { value: "10", label: "About 10" }, { value: "60", label: "About 60" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={!!first}
        answer="60"
        explain={<>About 60. For the {LOAD_TICKS * TICK_MS} ms the first load takes, the key is still missing, and each of the {READS_PER_S * LOAD_TICKS * TICK_MS / 1000} readers who arrive in that time sees a miss and queries the database itself. That is the thundering herd. Single-flight loads make them wait for the one load already running.</>}
      />

      <div className="pg-card">
        <span className="label">How the app uses the cache</span>
        <div className="cs-controls">
          <span className="cs-k">Pattern</span>
          <PgChoice<Pattern> label="Caching pattern" value={c.pattern} onChange={(v) => set({ pattern: v })}
            options={PATTERNS.map((p) => ({ value: p, label: PATTERN_NAME[p], note: PATTERN_JOB[p] }))} />
          <span />
          <p className="cs-note">{PATTERN_JOB[c.pattern]}.</p>
          <span className="cs-k">TTL</span>
          <PgChoice<string> label="Time to live" value={String(c.ttl)} onChange={(v) => set({ ttl: Number(v) as Ttl })}
            options={TTLS.map((t) => ({ value: String(t), label: `${t} s` }))} />
          <span className="cs-k">On write</span>
          {c.pattern === "write-through"
            ? <span className="cs-note">the writer sets the new price in the cache</span>
            : <PgChoice<Invalidate> label="On write" value={c.invalidate} onChange={(v) => set({ invalidate: v })}
                options={[{ value: "ttl", label: "Wait for TTL" }, { value: "delete", label: "Delete key" }]} />}
          <span className="cs-k">Fixes</span>
          <div className="pg-actions">
            <button className="pg-btn cs-tog" aria-pressed={coalesces(c)} disabled={c.pattern !== "aside"} onClick={() => set({ coalesce: !c.coalesce })}
              title="Concurrent misses for one key share one database load">{coalesces(c) ? "✓ " : ""}Single-flight{c.pattern !== "aside" ? " (built in)" : ""}</button>
            <button className="pg-btn cs-tog" aria-pressed={c.early} onClick={() => set({ early: !c.early })}
              title="Reload the entry in the background just before it expires">{c.early ? "✓ " : ""}Early refresh</button>
            <button className="pg-btn cs-tog" aria-pressed={c.lease} onClick={() => set({ lease: !c.lease })}
              title="A fill is refused if the key was invalidated after the fill began">{c.lease ? "✓ " : ""}Leases</button>
          </div>
          <span className="cs-k cs-breakk">Break it</span>
          <button className="pg-btn cs-break" aria-pressed={c.race} onClick={() => set({ race: !c.race })}>
            {c.race ? "✓ " : ""}Second write lands during a refill
          </button>
        </div>
        <p className="cs-note">{READS_PER_S} reads/s of one hot key. The price changes twice: at 8 s and at about 21 s{c.race ? " (with the race on: while a refill is in flight, after 18 s)" : ""}.</p>
        <div className="pg-actions"><PgButton primary onClick={() => dispatch({ type: "run" })}>Run 40 seconds</PgButton></div>
      </div>

      {run ? (
        <div className="pg-card">
          <span className="label">Run {run.id} · {describe(run.config)}</span>
          <span className="cs-legend"><i className="cs-q" />DB queries/s <i className="cs-q over" />over capacity <i className="cs-writekey" />price change</span>
          <QueryChart run={run} reduced={reduced} />
          <span className="cs-legend"><i className="cs-ok" />cache agrees with the database <i className="cs-old" />cache holds an old price</span>
          <FreshStrip run={run} />
          <dl className="pg-stats">
            <div><dt>Hit ratio</dt><dd>{pct(run.summary.hits, run.summary.reads)}</dd></div>
            <div><dt>DB queries</dt><dd>{run.summary.queries.toLocaleString("en")}</dd></div>
            <div className={run.summary.peakQueries > DB_CAPACITY ? "bad" : ""}><dt>Peak queries/s</dt><dd>{run.summary.peakQueries}</dd></div>
            <div className={run.summary.stale ? "bad" : ""}><dt>Stale reads</dt><dd>{run.summary.stale.toLocaleString("en")}</dd></div>
            <div className={run.summary.longestStale > 1 ? "bad" : ""}><dt>Longest stale</dt><dd>{run.summary.longestStale.toFixed(1)} s</dd></div>
            <div><dt>Fills refused</dt><dd>{run.summary.refused}</dd></div>
            <div><dt>Reads</dt><dd>{run.summary.reads.toLocaleString("en")}</dd></div>
            <div><dt>TTL</dt><dd>{run.config.ttl} s</dd></div>
          </dl>
          <span className="label">What happened, newest first</span>
          <PgLog entries={[...run.log].reverse().map((e) => ({ id: e.id, ok: e.ok, text: e.text, path: e.path }))} empty="Nothing notable." reduced={reduced} />
        </div>
      ) : (
        <div className="pg-card"><p className="pg-empty">Pick a pattern and press Run 40 seconds. The default is plain cache-aside with a 5 s TTL and no invalidation on write, a common first version.</p></div>
      )}

      {st.runs.length > 1 && (
        <div className="pg-card">
          <span className="label">Your runs · same reads and writes, compare the settings</span>
          <div className="cs-runs" role="table" aria-label="Your runs">
            <div role="row" className="cs-tr head"><span role="columnheader">Settings</span><span role="columnheader">Peak q/s</span><span role="columnheader">Stale reads</span><span role="columnheader">Longest stale</span></div>
            {st.runs.map((r) => (
              <button key={r.id} role="row" className={"cs-tr" + (r.id === st.shown ? " on" : "")} onClick={() => dispatch({ type: "show", id: r.id })}>
                <span role="cell">{r.id}. {describe(r.config)}</span>
                <span role="cell">{r.summary.peakQueries}</span>
                <span role="cell">{r.summary.stale.toLocaleString("en")}</span>
                <span role="cell">{r.summary.longestStale.toFixed(1)} s</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="cs-ch">
          {CHALLENGES.map((ch) => <li key={ch.id} className={challengeDone(st, ch.id) ? "done" : ""}>{challengeDone(st, ch.id) ? "✓ " : ""}{ch.text}</li>)}
        </ol>
      </div>

      {run && <Result run={run} />}

      <PgSources links={[
        { title: "Nishtala et al., Scaling Memcache (NSDI 2013), on leases for stale sets and herds", href: "https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala" },
        { title: "Vattani et al., Optimal Probabilistic Cache Stampede Prevention (VLDB 2015)", href: "https://www.vldb.org/pvldb/vol8/p886-vattani.pdf" },
        { title: "the Redis docs on cache-aside and stampede prevention", href: "https://redis.io/blog/cache-consistency-strategies/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.cs-controls { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.cs-controls > .pg-choice, .cs-controls > .pg-btn { justify-self: start; }
.cs-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.cs-breakk { color: var(--pain); }
.cs-note { margin: 0; font-size: .85rem; color: var(--ink-2); }
.pg-btn.cs-tog[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.pg-btn.cs-break { border-color: var(--pain); color: var(--pain); }
.pg-btn.cs-break[aria-pressed="true"] { background: var(--pain); color: var(--bg); }
.cs-chart { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.cs-q { fill: var(--accent); }
.cs-q.over { fill: var(--pain); }
.cs-cap { stroke: var(--ink); stroke-width: 1.2; stroke-dasharray: 5 3; }
.cs-write { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 2 2; }
.cs-ok { fill: var(--good); opacity: .55; }
.cs-old { fill: var(--pain); }
.cs-tiny, .cs-axis text { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.cs-axis line { stroke: var(--line); }
.cs-sweep { fill: var(--surface); transform-box: fill-box; transform-origin: right; animation: cs-sweep 1.6s linear forwards; }
@keyframes cs-sweep { from { transform: scaleX(1); } to { transform: scaleX(0); } }
.cs-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-family: var(--f-code); font-size: .62rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.cs-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 3px; vertical-align: -1px; background: var(--accent); }
.cs-legend i.over, .cs-legend i.cs-old { background: var(--pain); }
.cs-legend i.cs-ok { background: var(--good); opacity: .55; }
.cs-legend i.cs-writekey { background: none; height: 10px; width: 0; border-left: 1.5px dashed var(--ink-2); }
.cs-runs { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); font-size: .82rem; }
.cs-tr { display: grid; grid-template-columns: minmax(0, 3fr) repeat(3, minmax(0, 1fr)); gap: 1px; padding: 0; border: 0; background: var(--line); text-align: left; font: inherit; color: inherit; }
.cs-tr > span { background: var(--surface); padding: 4px 6px; font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
.cs-tr.head > span { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.cs-tr.on > span { background: var(--hl); }
button.cs-tr { cursor: pointer; }
.cs-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.cs-ch li.done { color: var(--good); }
@media (max-width: 560px) { .cs-controls { grid-template-columns: 1fr; } .cs-tr { font-size: .72rem; } }
@media (prefers-reduced-motion: reduce) { .cs-sweep { display: none; } }
`;
