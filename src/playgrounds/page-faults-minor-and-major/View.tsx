"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  FILE_PAGES, FRAMES, VPAGES, ZERO, cachedPages, init, isFile, isHeap, requestSummary, rss, step, usedFrames,
  type Mode, type Pid, type State, type Touch,
} from "./model";

const WHY: Record<Touch["why"], string> = {
  hit: "No fault: the page-table entry was there, so the MMU did the lookup in hardware.",
  cache: "Minor fault: the page was already in the page cache, so the kernel only filled in the page-table entry.",
  "zero-page": "Minor fault: a read of untouched heap maps the shared zero page. No RAM is used yet.",
  "zero-fill": "Minor fault: the first write to heap gets a fresh frame, zeroed by the kernel.",
  cow: "Minor fault, copy-on-write: the frame was shared with the other process, so the kernel copied 4 KiB and gave this process its own.",
  reuse: "Minor fault: the other process already took its copy, so this one is the last user and keeps the frame without copying.",
  disk: "Major fault: the page was not in RAM. The task slept until the disk returned it.",
  "read-only": "SIGSEGV: the index is mapped read-only, and the kernel kills the process for writing to it.",
  "no-vma": "SIGSEGV: no mapping covers this address.",
};

const CODE: Record<Lang, { map: string; populate: string; fork: string }> = {
  go: { map: "syscall.Mmap(fd, 0, size, PROT_READ, MAP_SHARED)", populate: "MAP_SHARED|syscall.MAP_POPULATE", fork: "Go has no fork(); a child starts with exec" },
  python: { map: "mmap.mmap(f.fileno(), 0, prot=mmap.PROT_READ)", populate: "flags=mmap.MAP_SHARED | mmap.MAP_POPULATE", fork: "os.fork()" },
  typescript: { map: "readSync(fd, buf, 0, 64, off)  // no mmap in Node core", populate: "readFileSync(path)  // load at startup", fork: "Node has no fork() of a running process" },
  rust: { map: "unsafe { Mmap::map(&file) }  // memmap2", populate: "MmapOptions::new().populate().map(&file)", fork: "libc::fork() (unsafe; rarely used)" },
};

const us = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} ms` : `${x.toFixed(1)} µs`);
const pageName = (v: number) => (isFile(v) ? `index ${v}` : isHeap(v) ? "heap" : "unmapped");

function pageClass(st: State, pid: Pid, v: number): string {
  const p = st.tables[pid][v];
  if (!isFile(v) && !isHeap(v)) return "hole";
  if (!p) return "empty";
  if (p.frame === ZERO) return "zero";
  if (!p.writable && isHeap(v)) return st.frames[p.frame].refs > 1 ? "cow" : "ro";
  return isFile(v) ? "file" : "rw";
}

function Arena({ st, reduced }: { st: State; reduced: boolean }) {
  const t = st.tables[st.pid];
  const fx = (j: number) => (j + 0.5) * (600 / FRAMES);
  const vx = (v: number) => (v + 0.5) * (600 / VPAGES);
  const hot = st.last && st.last.pid === st.pid ? st.last.vpage : -1;
  const cacheOf = Object.fromEntries(Object.entries(st.cache).map(([p, f]) => [f, Number(p)]));
  return (
    <svg className={"pf-arena" + (reduced ? "" : " anim")} viewBox="0 0 600 172" role="img"
      aria-label={`Page table of the ${st.pid}: ${Object.keys(t).length} pages mapped. ${usedFrames(st)} of ${FRAMES - 1} frames in use, ${cachedPages(st)} index pages in the page cache.`}>
      {Object.entries(t).map(([k, p]) => {
        const v = Number(k);
        const cls = pageClass(st, st.pid, v);
        return <line key={"l" + v} x1={vx(v)} y1={0} x2={fx(p.frame)} y2={62} className={"pf-map " + cls + (v === hot ? " hot" : "")} />;
      })}
      {Object.entries(st.cache).map(([pg, f]) => (
        <line key={"c" + pg} x1={fx(f)} y1={92} x2={vx(Number(pg))} y2={136} className="pf-cache" />
      ))}
      <text x={2} y={56} className="pf-col">frames (RAM)</text>
      {st.frames.map((f, j) => {
        const label = j === ZERO ? "zero" : f.content === null ? "" : typeof f.content === "object" && "file" in f.content ? `i${f.content.file}` : typeof f.content === "object" ? `h${f.content.anon}` : "";
        const kind = j === ZERO ? "zero" : f.content === null ? "free" : cacheOf[j] !== undefined ? "file" : "anon";
        const isHot = hot >= 0 && t[hot]?.frame === j;
        return (
          <g key={"f" + j}>
            <rect x={fx(j) - 16} y={62} width={32} height={30} className={"pf-frame " + kind + (isHot ? " hot" : "")} />
            <text x={fx(j)} y={81} textAnchor="middle" className="pf-t">{label}</text>
            {f.refs > 1 && j !== ZERO && <text x={fx(j) + 14} y={71} textAnchor="end" className="pf-refs">×{f.refs}</text>}
          </g>
        );
      })}
      <text x={2} y={130} className="pf-col">disk: index.bin</text>
      {Array.from({ length: FILE_PAGES }, (_, i) => (
        <g key={"d" + i}>
          <rect x={vx(i) - 20} y={136} width={40} height={26} className={"pf-disk" + (st.cache[i] !== undefined ? " cached" : "")} />
          <text x={vx(i)} y={153} textAnchor="middle" className="pf-t">i{i}</text>
        </g>
      ))}
    </svg>
  );
}

export default function PageFaultsPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const c = st.counters[st.pid];
  const sum = requestSummary(st.requests);
  const firstRequest = st.requests[0];

  return (
    <PgFrame title="Touch the memory of a search service" onReset={() => dispatch({ type: "reset" })}>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p>A search service has just started. It mapped its index file (pages index 0 to 5, read-only) and has four pages of heap. Nothing has been touched yet. Index page 2 is in the page cache because a backup read it last night. A request reads index pages 0, 2, 4 and 5 and writes one heap page.</p>
        <div className="pgc"><div className="pgc-line"><code>{CODE[lang].map}</code></div></div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <PgPredict<"none" | "micro" | "milli">
            question="The very first request after start: how long does it spend in page faults?"
            options={[{ value: "none", label: "None: mmap loaded the file" }, { value: "micro", label: "A few microseconds" }, { value: "milli", label: "Milliseconds" }]}
            value={st.prediction}
            onChange={(v) => dispatch({ type: "predict", value: v })}
            revealed={!!firstRequest}
            answer="milli"
            explain="mmap only records the mapping. Each first touch faults. Index page 2 was in the page cache, so it cost half a microsecond. Pages 0, 4 and 5 had to come from the disk, a millisecond each, while the request waited."
          />
        </div>
        <div className="pg-card">
          <span className="label">Run the service</span>
          <div className="pg-actions">
            <PgButton primary onClick={() => dispatch({ type: "request" })}>Serve a request</PgButton>
          </div>
          <span className="label">Break it, then fix it</span>
          <div className="pg-actions">
            <PgButton onClick={() => dispatch({ type: "pressure" })} title="Another process needs RAM; the kernel drops clean file pages">Memory pressure</PgButton>
            <PgButton onClick={() => dispatch({ type: "populate" })} disabled={st.populated} title={CODE[lang].populate}>Prefault the index</PgButton>
            <PgButton onClick={() => dispatch({ type: "fork" })} disabled={st.forked} title={CODE[lang].fork}>fork()</PgButton>
          </div>
          {st.populated && <p className="pg-note">Prefaulted with <code>{CODE[lang].populate}</code>: {us(st.startupUs)} of disk reads paid at startup, before the service is ready.</p>}
          {st.forked && <p className="pg-note">{lang === "go" || lang === "typescript" ? `${CODE[lang].fork}. ` : ""}Forked: the child shares every heap page with the parent, read-only, until one of them writes.</p>}
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Touch a page</span>
        <div className="pf-bar">
          <PgChoice<Mode> label="Access" value={st.mode} onChange={(m) => dispatch({ type: "mode", mode: m })}
            options={[{ value: "read", label: "Read" }, { value: "write", label: "Write" }]} />
          {st.forked && (
            <PgChoice<Pid> label="Process" value={st.pid} onChange={(p) => dispatch({ type: "pid", pid: p })}
              options={[{ value: "parent", label: "Parent" }, { value: "child", label: "Child" }]} />
          )}
        </div>
        <div className="pf-pages" role="group" aria-label={`Virtual pages of the ${st.pid}. Press one to ${st.mode} it.`}>
          {Array.from({ length: VPAGES }, (_, v) => {
            const cls = pageClass(st, st.pid, v);
            return (
              <button key={v} className={"pf-page " + cls + (st.last?.vpage === v && st.last.pid === st.pid ? " hot" : "")}
                onClick={() => dispatch({ type: "touch", vpage: v })} aria-label={`${st.mode} page ${v}, ${pageName(v)}, ${cls}`}>
                <b>p{v}</b><span>{isFile(v) ? `i${v}` : isHeap(v) ? "heap" : "—"}</span>
              </button>
            );
          })}
        </div>
        <Arena st={st} reduced={reduced} />
        <p className="pf-legend">
          <span className="file">index page</span><span className="rw">heap, writable</span><span className="cow">shared copy-on-write</span><span className="zero">zero page</span>
        </p>
        <PgLog reduced={reduced} empty="Press a page above. The line from the page to a frame is the page-table entry."
          entries={st.log.filter((e) => e.pid === st.pid).slice(0, 3).map((e) => ({
            id: e.id, ok: e.kind === "none" || e.kind === "minor", path: e.path,
            text: `${e.mode === "read" ? "Read" : "Write"} p${e.vpage}: ${WHY[e.why]} ${e.kind === "segv" ? "" : us(e.us) + "."}`,
          }))} />
        <dl className="pg-stats">
          <div><dt>Minor faults</dt><dd>{c.minor}</dd></div>
          <div className={c.major ? "bad" : ""}><dt>Major faults</dt><dd>{c.major}</dd></div>
          <div className={c.cow ? "bad" : ""}><dt>Copy-on-write copies</dt><dd>{c.cow}</dd></div>
          <div><dt>Time in faults</dt><dd>{us(c.us)}</dd></div>
          <div><dt>RSS ({st.pid})</dt><dd>{rss(st, st.pid) * 4} KiB</dd></div>
          <div><dt>Page cache</dt><dd>{cachedPages(st)} pages</dd></div>
        </dl>
      </div>

      {st.requests.length > 0 && (
        <div className="pg-card">
          <span className="label">Requests served</span>
          <div className="pf-scroll">
            <table className="pf-table">
              <thead><tr><th>#</th><th>Process</th><th>Minor</th><th>Major</th><th>Time in faults</th></tr></thead>
              <tbody>
                {st.requests.map((r) => (
                  <tr key={r.n}><th scope="row">{r.n}</th><td>{r.pid}{r.populated ? ", prefaulted" : ""}</td><td>{r.minor}</td><td className={r.major ? "bad" : ""}>{r.major}</td><td className={r.us > 100 ? "bad" : ""}>{us(r.us)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(sum || (firstRequest && firstRequest.major === 0)) && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your requests showed</span>
          <p className="pg-takeaway">
            {sum
              ? `Your slowest cold request spent ${us(sum.cold.us)} in ${sum.cold.major} major faults. Your fastest warm one spent ${us(sum.warm.us)}: ${Math.round(sum.cold.us / Math.max(sum.warm.us, 0.1)).toLocaleString("en-US")} times less. `
              : `Your first request spent ${us(firstRequest.us)} in faults, with no disk reads, because the index was prefaulted at startup. `}
            A fault is cheap when the page is already in RAM, in the page cache or shared after fork, and costs a disk read when it is not. Put the disk reads at startup, before the service is ready, and keep the pages in RAM.
            {st.forked ? ` After fork, the ${st.counters.child.cow + st.counters.parent.cow} write${st.counters.child.cow + st.counters.parent.cow === 1 ? "" : "s"} to shared heap cost a copy each, and only then used new RAM.` : " Now fork and write to a heap page in each process."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Brendan Gregg: Memory Leak (and Growth) Flame Graphs, page faults", href: "https://www.brendangregg.com/FlameGraphs/memoryflamegraphs.html" },
        { title: "Redis docs: latency from fork and transparent huge pages", href: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/" },
        { title: "man7: getrusage(2), minor and major faults", href: "https://man7.org/linux/man-pages/man2/getrusage.2.html" },
      ]} />

      <style>{`
        .pf-bar { display: flex; flex-wrap: wrap; gap: 8px; }
        .pf-pages { display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; margin-top: 8px; }
        .pf-page { display: flex; flex-direction: column; align-items: center; padding: 3px 0; font-family: var(--f-code); font-size: .62rem; border: 1px dashed var(--line); background: var(--bg); color: var(--ink); cursor: pointer; min-width: 0; }
        .pf-page b { font-size: .7rem; }
        .pf-page span { color: var(--ink-2); }
        .pf-page.file { border: 1px solid var(--accent); background: var(--hl); }
        .pf-page.rw { border: 1px solid var(--ink); background: var(--surface-2); }
        .pf-page.cow, .pf-page.ro { border: 2px dashed var(--pain); background: var(--pain-bg); }
        .pf-page.zero { border: 1px dotted var(--ink-2); background: var(--surface); }
        .pf-page.hole { opacity: .55; }
        .pf-page.hot { outline: 2px solid var(--accent); outline-offset: 1px; }
        .pf-page:focus-visible { outline: 2px solid var(--accent); }
        .pf-arena { width: 100%; height: auto; display: block; background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 12px 12px; border: 1px solid var(--line); border-top: 0; }
        .pf-col { font-family: var(--f-code); font-size: 8px; letter-spacing: .08em; text-transform: uppercase; fill: var(--ink-2); }
        .pf-t { font-family: var(--f-code); font-size: 10px; fill: var(--ink); }
        .pf-refs { font-family: var(--f-code); font-size: 8px; fill: var(--pain); font-weight: 700; }
        .pf-frame { fill: var(--bg); stroke: var(--line); }
        .pf-frame.file { fill: var(--hl); stroke: var(--accent); }
        .pf-frame.anon { fill: var(--surface-2); stroke: var(--ink); }
        .pf-frame.zero { fill: var(--surface); stroke: var(--ink-2); stroke-dasharray: 2 2; }
        .pf-frame.hot { stroke: var(--accent); stroke-width: 2.5; }
        .pf-disk { fill: var(--surface); stroke: var(--line); }
        .pf-disk.cached { stroke: var(--accent); }
        .pf-map { stroke: var(--ink); stroke-width: 1.2; }
        .pf-map.file { stroke: var(--accent); }
        .pf-map.cow, .pf-map.ro { stroke: var(--pain); stroke-dasharray: 4 3; }
        .pf-map.zero { stroke: var(--ink-2); stroke-dasharray: 1 3; }
        .pf-map.hot { stroke-width: 3; }
        .pf-cache { stroke: var(--accent); stroke-dasharray: 2 3; opacity: .7; }
        .pf-arena.anim .pf-frame { transition: fill .25s var(--ease), stroke .25s var(--ease); }
        .pf-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 4px 0 0; font-family: var(--f-code); font-size: .65rem; color: var(--ink-2); }
        .pf-legend span::before { content: ""; display: inline-block; width: 14px; height: 0; margin-right: 4px; vertical-align: middle; border-top: 2px solid var(--ink); }
        .pf-legend .file::before { border-color: var(--accent); }
        .pf-legend .cow::before { border-top: 2px dashed var(--pain); }
        .pf-legend .zero::before { border-top: 2px dotted var(--ink-2); }
        .pf-scroll { overflow-x: auto; }
        .pf-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
        .pf-table th, .pf-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
        .pf-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .pf-table td.bad { color: var(--pain); font-weight: 600; }
        @media (prefers-reduced-motion: reduce) { .pf-arena .pf-frame { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
