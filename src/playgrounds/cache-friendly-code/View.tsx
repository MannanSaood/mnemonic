"use client";
import { useEffect, useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, COLS, ELEM, LINE, NS, PER_LINE, RECORDS, SETS, WAYS,
  cached, cellInfo, cells, compare, init, lineLabel, missRate, ramBytes, runLabel, step, total,
  type Layout, type Order, type Prediction, type Rows, type State, type Workload,
} from "./model";

const LOOPS: Record<Lang, Record<"row" | "col" | "aos" | "soa", string>> = {
  go: {
    row: "for h := range hosts { for m := range minutes { totals[m] += samples[h*minutes+m] } }",
    col: "for m := range minutes { for h := range hosts { sum += samples[h*minutes+m] } }",
    aos: "for i := range orders { sum += orders[i].Price } // []Order{ID, Price, Qty, TS}",
    soa: "for _, p := range orders.Price { sum += p } // Price []float64",
  },
  python: {
    row: "totals = samples.sum(axis=0)  # adds whole rows: front to back",
    col: "for m in range(minutes): totals[m] = samples[:, m].sum()  # strided column",
    aos: "total = orders['price'].sum()  # structured array: price every 32 bytes",
    soa: "total = prices.sum()  # a plain float64 array of prices",
  },
  typescript: {
    row: "for (let h = 0; h < hosts; h++) for (let m = 0; m < minutes; m++) totals[m] += samples[h * minutes + m];",
    col: "for (let m = 0; m < minutes; m++) for (let h = 0; h < hosts; h++) sum += samples[h * minutes + m];",
    aos: "for (let i = 0; i < n; i++) sum += view.getFloat64(i * 32 + 8, true); // packed records",
    soa: "for (let i = 0; i < n; i++) sum += prices[i]; // Float64Array",
  },
  rust: {
    row: "for row in samples.chunks_exact(minutes) { for (t, v) in totals.iter_mut().zip(row) { *t += v } }",
    col: "for m in 0..minutes { for h in 0..hosts { sum += samples[h * minutes + m] } }",
    aos: "let sum: f64 = orders.iter().map(|o| o.price).sum(); // Vec<Order>",
    soa: "let sum: f64 = orders.price.iter().sum(); // price: Vec<f64>",
  },
};

const RESULT_TEXT = { hit: "hit", miss: "miss", prefetched: "hit on a prefetched line" } as const;
const hex = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(4, "0");
const ns = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} µs` : `${x} ns`);

function Memory({ st, dispatch, reduced }: { st: State; dispatch: (a: { type: "touch"; cell: number }) => void; reduced: boolean }) {
  const n = cells(st);
  return (
    <div className={"cf-mem" + (reduced ? "" : " anim")} role="group" aria-label={`Memory, ${n * ELEM} bytes, 16 cells of 8 bytes per row, a cache line every 8 cells. Press a cell to read it.`}>
      {Array.from({ length: n }, (_, i) => {
        const info = cellInfo(st, i);
        const line = Math.floor(i / PER_LINE);
        const mark = st.marks[i];
        const cls = ["cf-cell",
          mark === 1 ? "hit" : mark === 2 ? "miss" : mark === 3 ? "pre" : "",
          cached(st.sets, line) ? "in" : "",
          info.used ? "" : "unused",
          st.last?.cell === i ? "cur" : "",
          i % PER_LINE === 0 ? "ls" : "",
        ].filter(Boolean).join(" ");
        return (
          <button key={i} className={cls} onClick={() => dispatch({ type: "touch", cell: i })}
            aria-label={`${info.text}, line ${line}${cached(st.sets, line) ? ", in cache" : ""}`}>
            {st.workload === "records" ? info.field![0] : ""}
          </button>
        );
      })}
    </div>
  );
}

function Cache({ st }: { st: State }) {
  return (
    <div className="cf-cache" role="table" aria-label={`Cache: ${SETS} sets of ${WAYS} ways, ${LINE}-byte lines`}>
      <div className="cf-crow head" role="row"><span role="columnheader">set</span>{Array.from({ length: WAYS }, (_, w) => <span key={w} role="columnheader">way {w}</span>)}</div>
      {st.sets.map((ways, s) => (
        <div key={s} role="row" className={"cf-crow" + (st.last?.set === s ? " cur" : "")}>
          <span role="rowheader">{s}</span>
          {ways.map((w, j) => {
            const fresh = st.last && w.line === st.last.line;
            const pre = st.last?.prefetched === w.line && w.line >= 0;
            return (
              <span key={j} role="cell" className={"cf-way" + (w.line < 0 ? " empty" : "") + (fresh ? ` ${st.last!.result}` : "") + (pre ? " pf" : "")}>
                {w.line < 0 ? "empty" : <><b>{lineLabel(st, w.line)}</b><i>line {w.line} · tag {Math.floor(w.line / SETS)}{w.pre ? " · prefetched" : ""}</i></>}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function lastLine(st: State): string {
  const a = st.last;
  if (!a) return "Press Step, Play or Run, or press any cell to read it yourself.";
  const what = cellInfo(st, a.cell).text;
  const cost = a.result === "hit" ? NS.hit : a.result === "miss" ? NS.miss : NS.prefetched;
  let s = `Read ${what} at ${hex(a.addr)}: line ${a.line} → set ${a.set}, tag ${a.tag}, offset ${a.offset}. ${RESULT_TEXT[a.result][0].toUpperCase() + RESULT_TEXT[a.result].slice(1)}, ${cost} ns.`;
  if (a.result === "miss") s += ` The whole ${LINE}-byte line came from RAM${a.evicted !== null ? `, evicting ${lineLabel(st, a.evicted)}` : ""}.`;
  if (a.prefetched !== null) s += ` The prefetcher also fetched ${lineLabel(st, a.prefetched)}.`;
  return s;
}

function Result({ st }: { st: State }) {
  const c = compare(st);
  if (!c) return null;
  const ratio = c.slow.stats.ns / c.fast.stats.ns;
  const same = c.slow.stats.reads === c.fast.stats.reads;
  let take: string;
  if (st.workload === "matrix" && c.slow.order === "col" && c.fast.order === "row")
    take = st.rows === 32
      ? `Row order uses all ${PER_LINE} values of each line it fetches. Column order jumps ${COLS * ELEM} bytes per read, and by the time it comes back for the next minute, the ${st.rows} lines of the last column pass (${st.rows * LINE} bytes) have been pushed out of a ${SETS * WAYS * LINE}-byte cache. Walk memory in the order it is laid out.`
      : `With ${st.rows} hosts both orders cost about the same: the lines one column pass needs fit in the cache, so the next minutes hit. This is why the slow loop passed every test on small data.`;
  else if (st.workload === "records")
    take = `The loop reads one field. In an array of structs each ${LINE}-byte line brings two whole orders, and three quarters of every line is id, qty and ts. In a struct of arrays a line is ${PER_LINE} prices, all used. Lay data out by how hot loops read it.`;
  else take = "The prefetcher hides the wait for a sequential walk, but every line it streams in still costs bandwidth, and it cannot guess a jumping pattern.";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your runs show</span>
      <p>{c.slow.label}: {c.slow.stats.misses} misses in {c.slow.stats.reads} reads, {ns(c.slow.stats.ns)}. {c.fast.label}: {c.fast.stats.misses} misses, {ns(c.fast.stats.ns)}. {same ? `The same ${c.slow.stats.reads} reads` : "The same work"}, {ratio.toFixed(1)}× the time.</p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function CacheFriendlyPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const n = total(st);
  const s = st.stats;

  useEffect(() => {
    if (!playing) return;
    if (st.pos >= n) { setPlaying(false); return; }
    const t = setTimeout(() => dispatch({ type: "step", n: 1 }), 45);
    return () => clearTimeout(t);
  }, [playing, st.pos, n, dispatch]);

  const play = () => { if (reduced) dispatch({ type: "run" }); else { if (st.pos >= n) dispatch({ type: "step", n: 1 }); setPlaying(true); } };
  const set = (a: Parameters<typeof dispatch>[0]) => { setPlaying(false); dispatch(a); };
  const loopKey = st.workload === "matrix" ? st.order : st.layout;
  const colRun32 = st.runs.some((r) => r.workload === "matrix" && r.rows === 32 && r.order === "col" && !r.prefetch);

  return (
    <PgFrame title="Walk memory through a cache" onReset={() => { setPlaying(false); dispatch({ type: "reset" }); }}>
      <PgPredict<Prediction>
        question={`A matrix of 32 hosts × ${COLS} minutes of float64 (4 KiB) and a 1 KiB cache. Row order reads it with 64 misses. Column order reads the same 512 values. How many of its reads miss?`}
        options={[{ value: "same", label: "64, the same" }, { value: "double", label: "About 128" }, { value: "all", label: "All 512" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={colRun32}
        answer="all"
        explain={`Every one. Each read in a column is ${COLS * ELEM} bytes after the last, so it needs a new line. One column pass touches 32 lines, twice what the cache holds, so when the loop comes back for the next minute, the line it needs has been evicted. A miss fetches 64 bytes and uses 8.`}
      />

      <div className="pg-req">
        <span className="label">The loop</span>
        <div className="cf-rows">
          <span className="pg-place">Data</span>
          <PgChoice<Workload> label="Data" value={st.workload} onChange={(v) => set({ type: "workload", value: v })}
            options={[{ value: "matrix", label: "Metrics matrix" }, { value: "records", label: "Order records" }]} />
          {st.workload === "matrix" ? <>
            <span className="pg-place">Hosts</span>
            <PgChoice<"8" | "32"> label="Hosts" value={String(st.rows) as "8" | "32"} onChange={(v) => set({ type: "rows", value: Number(v) as Rows })}
              options={[{ value: "8", label: "8 hosts (1 KiB, fits)" }, { value: "32", label: "32 hosts (4 KiB)" }]} />
            <span className="pg-place">Order</span>
            <PgChoice<Order> label="Loop order" value={st.order} onChange={(v) => set({ type: "order", value: v })}
              options={[{ value: "row", label: "Row: host, then minute" }, { value: "col", label: "Column: minute, then host" }]} />
          </> : <>
            <span className="pg-place">Layout</span>
            <PgChoice<Layout> label="Layout" value={st.layout} onChange={(v) => set({ type: "layout", value: v })}
              options={[{ value: "aos", label: "Array of structs" }, { value: "soa", label: "Struct of arrays" }]} />
          </>}
          <span className="pg-place">Prefetcher</span>
          <PgChoice<"off" | "on"> label="Next-line prefetcher" value={st.prefetch ? "on" : "off"} onChange={(v) => set({ type: "prefetch", value: v === "on" })}
            options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]} />
        </div>
        <div className="pgc"><div className="pgc-line"><code>{LOOPS[lang][loopKey]}</code></div></div>
        <div className="pg-actions">
          <PgButton onClick={() => set({ type: "step", n: 1 })}>Step</PgButton>
          <PgButton onClick={() => set({ type: "step", n: PER_LINE })}>Step {PER_LINE}</PgButton>
          <PgButton primary onClick={play} disabled={playing}>Play</PgButton>
          <PgButton onClick={() => set({ type: "run" })}>Run to end</PgButton>
        </div>
        <p className="muted">Read {st.pos} of {n}. Changing a setting starts again with an empty cache. Each cell is 8 bytes; a thick left edge starts a 64-byte line.{st.workload === "records" ? ` Letters are fields: i(d), p(rice), q(ty), t(s) of ${RECORDS} orders.` : ""}</p>
      </div>

      <div className="pg-grid cf-grid">
        <div className="pg-card">
          <span className="label">Memory · {cells(st) * ELEM} bytes{st.workload === "matrix" ? ` · one row per host` : ""}</span>
          <Memory st={st} dispatch={(a) => { setPlaying(false); dispatch(a); }} reduced={reduced} />
          <p className="cf-legend"><span className="hit">hit</span><span className="miss">miss</span><span className="pre">prefetched</span><span className="in">line in cache</span></p>
        </div>
        <div className="pg-card">
          <span className="label">Cache · {SETS} sets × {WAYS} ways × {LINE} B = {SETS * WAYS * LINE} B, LRU</span>
          <Cache st={st} />
        </div>
      </div>

      <p className="cf-last" aria-live="polite">{lastLine(st)}</p>

      <dl className="pg-stats cf-stats">
        <div><dt>Reads</dt><dd>{s.reads}</dd></div>
        <div className={missRate(s) > 0.3 ? "bad" : ""}><dt>Misses</dt><dd>{s.misses} ({Math.round(missRate(s) * 100)}%)</dd></div>
        <div><dt>Hits</dt><dd>{s.hits + s.prefHits}</dd></div>
        <div className={s.ns > 20_000 ? "bad" : ""}><dt>Time (model)</dt><dd>{ns(s.ns)}</dd></div>
        <div><dt>Bytes used</dt><dd>{s.reads * ELEM}</dd></div>
        <div className={ramBytes(s) > 2 * s.reads * ELEM ? "bad" : ""}><dt>Bytes from RAM</dt><dd>{ramBytes(s)}</dd></div>
        <div><dt>Prefetches</dt><dd>{s.prefetches}</dd></div>
        <div><dt>Cost model</dt><dd>hit {NS.hit} · miss {NS.miss} ns</dd></div>
      </dl>

      {st.runs.length > 0 && (
        <div className="pg-card">
          <span className="label">Finished runs</span>
          <div className="cf-scroll">
            <table className="cf-table">
              <thead><tr><th>#</th><th>Loop</th><th>Reads</th><th>Misses</th><th>Time</th><th>From RAM</th></tr></thead>
              <tbody>
                {st.runs.map((r) => (
                  <tr key={r.id}><th scope="row">{r.id}</th><td>{r.label}</td><td>{r.stats.reads}</td>
                    <td className={missRate(r.stats) > 0.3 ? "bad" : ""}>{r.stats.misses}</td><td>{ns(r.stats.ns)}</td><td>{ramBytes(r.stats)} B</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges: {CHALLENGES.filter((c) => st.done[c.id]).length} of {CHALLENGES.length}</span>
        <ul className="cf-list">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "got" : ""}><span aria-hidden="true">{st.done[c.id] ? "■" : "□"}</span> {c.text}</li>)}
        </ul>
        <p className="muted">Clicking cells yourself is for exploring; a run you clicked into is not recorded. Next: {runLabel(st)}.</p>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Igor Ostrovsky's Gallery of Processor Cache Effects", href: "http://igoro.com/archive/gallery-of-processor-cache-effects/" },
        { title: "the UW CSE 351 cache simulator", href: "https://courses.cs.washington.edu/courses/cse351/cachesim/" },
        { title: "Ulrich Drepper, What Every Programmer Should Know About Memory", href: "https://people.freebsd.org/~lstewart/articles/cpumemory.pdf" },
      ]} />

      <style>{CSS}</style>
    </PgFrame>
  );
}

const CSS = `
.cf-rows { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.cf-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); }
.cf-mem { display: grid; grid-template-columns: repeat(16, minmax(0, 1fr)); gap: 1px; padding: 4px; border: 1px solid var(--line); background: var(--surface); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 12px 12px; }
.cf-cell { min-width: 0; height: 14px; padding: 0; border: 1px solid var(--line); background: var(--bg); color: var(--ink-2); font-family: var(--f-code); font-size: .5rem; line-height: 1; cursor: pointer; }
.cf-cell.ls { border-left: 3px solid var(--ink-2); }
.cf-cell.in { background: var(--hl); }
.cf-cell.unused { opacity: .55; }
.cf-cell.hit { background: color-mix(in srgb, var(--good) 45%, var(--surface)); }
.cf-cell.pre { background: color-mix(in srgb, var(--accent) 45%, var(--surface)); }
.cf-cell.miss { background: color-mix(in srgb, var(--pain) 55%, var(--surface)); }
.cf-cell.cur { outline: 2px solid var(--ink); outline-offset: -1px; z-index: 1; position: relative; }
.cf-cell:focus-visible { outline: 2px solid var(--accent); }
.cf-mem.anim .cf-cell { transition: background-color .2s var(--ease); }
.cf-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 4px 0 0; font-family: var(--f-code); font-size: .62rem; color: var(--ink-2); text-transform: uppercase; letter-spacing: .05em; }
.cf-legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: -1px; border: 1px solid var(--line); }
.cf-legend .hit::before { background: color-mix(in srgb, var(--good) 45%, var(--surface)); }
.cf-legend .miss::before { background: color-mix(in srgb, var(--pain) 55%, var(--surface)); }
.cf-legend .pre::before { background: color-mix(in srgb, var(--accent) 45%, var(--surface)); }
.cf-legend .in::before { background: var(--hl); }
.cf-cache { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); font-family: var(--f-code); font-size: .66rem; }
.cf-crow { display: grid; grid-template-columns: 2.4em repeat(2, minmax(0, 1fr)); gap: 1px; }
.cf-crow > span { background: var(--surface); padding: 3px 5px; min-width: 0; overflow: hidden; }
.cf-crow.head > span { color: var(--ink-2); text-transform: uppercase; letter-spacing: .06em; font-size: .58rem; }
.cf-crow.cur > span:first-child { background: var(--ink); color: var(--bg); }
.cf-way b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cf-way i { display: block; font-style: normal; color: var(--ink-2); font-size: .58rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cf-way.empty { color: var(--ink-2); }
.cf-way.hit { background: color-mix(in srgb, var(--good) 30%, var(--surface)); }
.cf-way.miss { background: color-mix(in srgb, var(--pain) 35%, var(--surface)); }
.cf-way.prefetched, .cf-way.pf { background: color-mix(in srgb, var(--accent) 30%, var(--surface)); }
.cf-last { margin: 0; font-size: .92rem; }
.cf-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.cf-scroll { overflow-x: auto; }
.cf-table { width: 100%; border-collapse: collapse; font-size: .85rem; font-variant-numeric: tabular-nums; }
.cf-table th, .cf-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
.cf-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.cf-table td.bad { color: var(--pain); font-weight: 600; }
.cf-list { list-style: none; padding-left: 0 !important; }
.cf-list li.got { color: var(--good); }
@media (max-width: 720px) { .cf-grid { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .cf-rows { grid-template-columns: 1fr; } .cf-stats { grid-template-columns: 1fr 1fr; } }
@media (prefers-reduced-motion: reduce) { .cf-mem.anim .cf-cell { transition: none; } }
`;
