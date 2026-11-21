"use client";
import { useRef, useState, type KeyboardEvent } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  DEVICES, LOOKUPS, MAX_RA, PAGES, PAGE_KB, cachedShare, comparison, goals, init, step,
  type DeviceId, type Event, type Run,
} from "./model";

const t = (us: number) => (us < 1000 ? `${Math.round(us)} µs` : `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`);
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const mbps = (r: Run) => (r.c.reads * PAGE_KB * 1024) / r.c.tookUs; // bytes per µs = MB/s

const HOW: Record<Lang, string> = {
  go: "Go: os.File.ReadAt is a pread(2). golang.org/x/sys/unix.Fadvise(fd, 0, 0, unix.FADV_SEQUENTIAL) widens readahead, FADV_RANDOM turns it off. A goroutine stuck in a cache-miss read holds an OS thread; the runtime hands its P to another thread.",
  python: "Python: os.pread(fd, n, off) and f.readinto(buf). os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_SEQUENTIAL) is in the standard library. The GIL is released while the read waits on the disk.",
  typescript: "Node.js: fs reads run on the libuv thread pool (4 threads by default, UV_THREADPOOL_SIZE). Cold-cache reads hold those threads for a whole disk wait each, so a burst of misses queues behind four of them. There is no fadvise in fs.",
  rust: "Rust: std::os::unix::fs::FileExt::read_at is a pread(2). libc::posix_fadvise or nix's fcntl::posix_fadvise sets the hint. Blocking reads in tokio go to spawn_blocking threads, so a miss does not stall the runtime.",
};

type Guess = "lookups" | "warm" | "same";

function describe(e: Event): string {
  const pg = `page ${e.page}`;
  const async = e.async ? ` Started readahead of pages ${e.async[0]}–${e.async[1]} in the background.` : "";
  switch (e.kind) {
    case "hit": return `${pg}: in the page cache, ${t(e.took)}.${async}`;
    case "wait": return `${pg}: readahead already asked for it, waited ${t(e.took)} for the I/O to land.${async}`;
    case "miss": return e.io && e.io[1] > e.io[0]
      ? `${pg}: miss. One I/O for pages ${e.io[0]}–${e.io[1]} (readahead), ${t(e.took)}.`
      : `${pg}: miss. One I/O for this page only, ${t(e.took)}.`;
    case "direct": return `${pg}: O_DIRECT, straight to the device, ${t(e.took)}. Nothing is cached.`;
  }
}

function runLabel(r: Run): string {
  const what = r.kind === "sequential" ? "Whole file, in order" : `${LOOKUPS} lookups`;
  const warm = r.warmAtStart === 0 ? "cold" : r.warmAtStart >= 0.99 ? "warm" : `${Math.round(r.warmAtStart * 100)}% cached`;
  const mode = r.direct ? "O_DIRECT" : r.readahead ? "readahead" : "no readahead";
  return `${what} · ${warm} · ${mode}`;
}

export default function PageCachePlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const [focus, setFocus] = useState(0);
  const cells = useRef<(HTMLButtonElement | null)[]>([]);
  const cmp = comparison(st);
  const g = goals(st);
  const last = st.runs[st.runs.length - 1];
  const lastIo = st.log[0]?.io ?? st.log[0]?.async;
  const cached = Math.round(cachedShare(st) * 100);

  const move = (e: KeyboardEvent, i: number) => {
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 16, ArrowUp: -16, Home: -i, End: PAGES - 1 - i }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    const j = Math.min(PAGES - 1, Math.max(0, i + d));
    setFocus(j);
    cells.current[j]?.focus();
  };

  return (
    <PgFrame title="A 1 MiB index file, the page cache and a disk" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question={`A search service restarts with a cold page cache and must answer ${LOOKUPS} random lookups in its 1 MiB index. Plan A: serve them straight away. Plan B: first read the whole file front to back, then serve them. Which finishes first?`}
        options={[{ value: "lookups", label: "Plan A, it reads less" }, { value: "warm", label: "Plan B, despite reading more" }, { value: "same", label: "About the same" }]}
        value={guess} onChange={setGuess} revealed={!!cmp} answer="warm"
        explain={cmp ? <>Plan A took {t(cmp.coldLookups.c.tookUs)} in {n(cmp.coldLookups.c.ios, "disk I/O")}, one per page it touched. Plan B read {(cmp.warmup.c.diskPages / Math.max(1, cmp.coldLookups.c.diskPages)).toFixed(1)}× as much from the disk in {t(cmp.warmup.c.tookUs)} with only {n(cmp.warmup.c.ios, "I/O")}, because readahead turned the sequential pass into growing batches. After that every lookup was a cache hit: {t(cmp.warmLookups.c.tookUs)} for all {LOOKUPS}.</> : null}
      />

      <p className="pg-rule"><b>How to find out:</b> run the {LOOKUPS} lookups on a cold cache. Then press Drop caches, read the whole file in order, and run the same lookups again.</p>

      <div className="pc-controls">
        <PgChoice<DeviceId> label="Disk" value={st.device} onChange={(d) => dispatch({ type: "device", device: d })}
          options={(Object.keys(DEVICES) as DeviceId[]).map((d) => ({ value: d, label: DEVICES[d].label, note: DEVICES[d].note }))} />
        <PgChoice<"on" | "off"> label="Readahead" value={st.readahead ? "on" : "off"} onChange={(v) => dispatch({ type: "readahead", on: v === "on" })}
          options={[{ value: "on", label: "Readahead on" }, { value: "off", label: "FADV_RANDOM (off)" }]} />
        <PgChoice<"buffered" | "direct"> label="Open mode" value={st.direct ? "direct" : "buffered"} onChange={(v) => dispatch({ type: "direct", on: v === "direct" })}
          options={[{ value: "buffered", label: "Buffered" }, { value: "direct", label: "O_DIRECT" }]} />
      </div>

      <div className="pg-actions">
        <PgButton primary onClick={() => dispatch({ type: "lookups" })}>Run the {LOOKUPS} lookups</PgButton>
        <PgButton primary onClick={() => dispatch({ type: "sequential" })}>Read whole file in order</PgButton>
        <PgButton onClick={() => dispatch({ type: "next" })}>Read next page</PgButton>
        <PgButton onClick={() => dispatch({ type: "drop" })}>Drop caches (restart)</PgButton>
      </div>

      <section className="pc-file" aria-label="The file, page by page">
        <header>
          <span className="label">index.bin · {PAGES} pages of {PAGE_KB} KiB · {cached}% in the page cache</span>
          <span className="pc-hint">Click a page to read it.</span>
        </header>
        <div className="pc-grid" role="group" aria-label="Pages of the file. Arrow keys move, Enter reads.">
          {st.pages.map((p, i) => {
            const inflight = p.cached && p.readyAt > st.now;
            const inIo = lastIo && i >= lastIo[0] && i <= lastIo[1];
            const cls = ["pc-cell", inflight ? "inflight" : p.cached ? (p.used ? "used" : "ahead") : "", p.mark ? "mark" : "", st.cursor === i ? "cursor" : "", inIo ? "io" : "", reduced ? "" : "anim"].filter(Boolean).join(" ");
            const state = inflight ? "being read from disk" : p.cached ? (p.used ? "in the page cache" : "in the page cache, read ahead, not used yet") : "not cached";
            return (
              <button key={i} ref={(el) => { cells.current[i] = el; }} className={cls} tabIndex={i === focus ? 0 : -1}
                aria-label={`Page ${i}, ${state}${p.mark ? ", readahead marker" : ""}`}
                onFocus={() => setFocus(i)} onKeyDown={(e) => move(e, i)}
                onClick={() => dispatch({ type: "read", page: i })} />
            );
          })}
        </div>
        <p className="pc-legend">
          <span><i className="pc-cell" /> on disk only</span>
          <span><i className="pc-cell inflight" /> I/O in flight</span>
          <span><i className="pc-cell ahead" /> read ahead, not used yet</span>
          <span><i className="pc-cell used" /> cached and read</span>
          <span><i className="pc-cell mark" /> readahead marker</span>
        </p>
      </section>

      <dl className="pg-stats">
        <div><dt>Reads</dt><dd>{st.total.reads}</dd></div>
        <div><dt>Cache hits</dt><dd>{st.total.hits}</dd></div>
        <div className={st.total.ios ? "bad" : ""}><dt>Disk I/Os</dt><dd>{st.total.ios}</dd></div>
        <div className={st.total.waitedUs ? "bad" : ""}><dt>Waiting on disk</dt><dd>{t(st.total.waitedUs)}</dd></div>
      </dl>

      {last && (
        <div className="pg-result" aria-live="polite">
          <span className="label">Last run · {runLabel(last)} · {DEVICES[last.device].label}</span>
          <p>{n(last.c.reads, "read")} of {PAGE_KB} KiB: {n(last.c.hits, "cache hit")}, {n(last.c.ios, "disk I/O")} ({last.c.diskPages} pages), {t(last.c.tookUs)} in all, {Math.round(mbps(last))} MB/s.</p>
          <p className="muted">
            {last.direct
              ? "O_DIRECT skipped the page cache, so every read paid a full device round trip, cached or not. Databases use it because they keep their own cache."
              : last.kind === "sequential" && last.readahead && last.warmAtStart === 0
                ? `Readahead grew its window 4 → 8 → 16 → ${MAX_RA} pages, and the marker page started each next batch while the reader was still busy. ${PAGES} reads cost ${n(last.c.ios, "I/O")}.`
                : last.kind === "sequential" && !last.readahead && last.warmAtStart === 0
                  ? "With readahead off, the in-order pass waited on the disk for every single page."
                  : last.c.ios === 0
                    ? "Every page was already in the page cache. Each read was a memory copy, about a microsecond."
                    : "Random reads give readahead nothing to predict, so each new page cost one full disk wait."}
          </p>
        </div>
      )}

      {cmp && (
        <div className="pg-result">
          <span className="label">Your restart, in your numbers</span>
          <p>Lookups on a cold cache: <b>{t(cmp.coldLookups.c.tookUs)}</b>. Warm-up pass then the same lookups: <b>{t(cmp.warmup.c.tookUs)} + {t(cmp.warmLookups.c.tookUs)}</b>, {(cmp.coldLookups.c.tookUs / (cmp.warmup.c.tookUs + cmp.warmLookups.c.tookUs)).toFixed(1)}× faster, while reading {(cmp.warmup.c.diskPages / Math.max(1, cmp.coldLookups.c.diskPages)).toFixed(1)}× as much from the disk.</p>
          <p className="pg-takeaway">The disk charges per I/O, not per byte. A sequential pass lets readahead batch {PAGES} pages into {n(cmp.warmup.c.ios, "I/O")}; random misses pay one wait each. Warm the cache with big sequential reads before you take traffic.</p>
        </div>
      )}

      {st.log.length > 0 && (
        <div>
          <span className="label">What the kernel did, newest first</span>
          <ul className="pc-log" aria-live="polite">
            {st.log.slice(0, 6).map((e, i) => <li key={`${st.total.reads}-${i}`} className={e.kind === "hit" ? "ok" : "slow"}>{describe(e)}</li>)}
          </ul>
        </div>
      )}

      {st.runs.length > 0 && (
        <div className="pc-table" role="region" aria-label="Your runs" tabIndex={0}>
          <table>
            <thead><tr><th>Run</th><th>Disk</th><th>I/Os</th><th>Time</th></tr></thead>
            <tbody>
              {st.runs.slice(-6).map((r, i) => (
                <tr key={i}><td>{runLabel(r)}</td><td>{r.device === "nvme" ? "NVMe" : "network"}</td><td>{r.c.ios}</td><td>{t(r.c.tookUs)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="pc-goals">
          <li className={g.coldLookups ? "done" : ""}>{g.coldLookups ? "✓" : "○"} Run the {LOOKUPS} lookups on a cold cache.</li>
          <li className={g.warmBeatsCold ? "done" : ""}>{g.warmBeatsCold ? "✓" : "○"} Beat that time with a cold warm-up pass plus the same lookups.</li>
          <li className={g.fewIos ? "done" : ""}>{g.fewIos ? "✓" : "○"} Read the whole cold file in 12 disk I/Os or fewer.</li>
          <li className={g.noReadahead ? "done" : ""}>{g.noReadahead ? "✓" : "○"} Make the in-order pass slower than the random lookups.</li>
          <li className={g.directWarm ? "done" : ""}>{g.directWarm ? "✓" : "○"} Make a fully cached file as slow as a cold one.</li>
        </ul>
      </div>

      <p className="pc-how"><span className="label">In your language</span> {HOW[lang]}</p>

      <PgSources links={[
        { title: "Brendan Gregg's page cache hit ratio and cachestat", href: "https://www.brendangregg.com/blog/2014-12-31/linux-page-cache-hit-ratio.html" },
        { title: "Viacheslav Biriukov's Linux page cache series for SREs", href: "https://biriukov.dev/docs/page-cache/0-linux-page-cache-for-sre/" },
        { title: "Fengguang Wu's readahead paper (OLS 2007)", href: "https://www.kernel.org/doc/ols/2007/ols2007v2-pages-97-106.pdf" },
      ]} />

      <style>{`
        .pc-controls { display: flex; flex-wrap: wrap; gap: 8px; }
        .pc-file { border: 1px solid var(--line); background: var(--surface); padding: 8px; display: grid; gap: 6px; }
        .pc-file header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; }
        .pc-hint { font-size: .8rem; color: var(--ink-2); }
        .pc-grid { display: grid; grid-template-columns: repeat(16, minmax(0, 1fr)); gap: 2px; background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); }
        .pc-cell { aspect-ratio: 1; min-width: 0; padding: 0; border: 1px solid var(--line); background: var(--bg); position: relative; cursor: pointer; display: inline-block; }
        .pc-cell.anim { transition: background .25s, border-color .25s; }
        .pc-cell.ahead { background: var(--hl); border-color: var(--accent); }
        .pc-cell.used { background: var(--accent); border-color: var(--accent); }
        .pc-cell.inflight { background: repeating-linear-gradient(45deg, var(--hl) 0 3px, var(--surface) 3px 6px); border-color: var(--accent); }
        .pc-cell.mark::after { content: ""; position: absolute; inset: 30%; background: var(--pain); }
        .pc-cell.io { box-shadow: inset 0 -3px 0 var(--pain); }
        .pc-cell.cursor { outline: 2px solid var(--ink); outline-offset: -2px; }
        .pc-cell:hover { border-color: var(--ink-2); }
        .pc-legend { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: .78rem; color: var(--ink-2); }
        .pc-legend span { display: inline-flex; align-items: center; gap: 5px; }
        .pc-legend .pc-cell { width: 12px; cursor: default; }
        .pc-log { list-style: none; padding: 0; margin: 4px 0 0; display: grid; gap: 2px; font-size: .85rem; }
        .pc-log li { border-left: 3px solid var(--line); padding: 2px 8px; }
        .pc-log li.ok { border-color: var(--good); }
        .pc-log li.slow { border-color: var(--pain); }
        .pc-table { overflow-x: auto; }
        .pc-table table { border-collapse: collapse; width: 100%; font-size: .8rem; font-family: var(--f-code); }
        .pc-table th, .pc-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
        .pc-table th { font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .pc-goals { list-style: none; padding-left: 0 !important; }
        .pc-goals li.done { color: var(--good); }
        .pc-how { margin: 0; font-size: .92rem; }
        @media (prefers-reduced-motion: reduce) { .pc-cell.anim { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
