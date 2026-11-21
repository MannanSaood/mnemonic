"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  HIGH, KERNEL, LIMIT, PROCS, PROC_INFO, READ, STEP, SWAP_MAX, init, score, step, swapMax, swapTotal, usage,
  type ProcId,
} from "./model";

const HOW: Record<Lang, string> = {
  go: "Go: the runtime does not read memory.max. Set GOMEMLIMIT (Go 1.19+) a little below the limit, and the GC works harder as the heap nears it instead of letting it grow into the OOM killer.",
  python: "Python: the interpreter has no memory limit of its own. It keeps calling malloc, and in a container it is usually OOM-killed long before a MemoryError, because the kernel overcommits.",
  typescript: "Node.js: V8's old-space limit (--max-old-space-size) caps the JS heap; recent versions size the default from the container limit. Buffers and native memory sit outside it and still count toward memory.max.",
  rust: "Rust: no GC and no limit. A failed allocation aborts the process, but under overcommit the allocation usually succeeds and the OOM killer acts first, when the pages are touched.",
};

const ADJ = [
  { value: "-1000", label: "-1000 never" },
  { value: "0", label: "0" },
  { value: "500", label: "+500" },
  { value: "1000", label: "+1000 first" },
];

type Guess1 = "kill" | "cache" | "enomem";
type Guess2 = "asker" | "largest" | "newest";

export default function OomPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [g1, setG1] = useState<Guess1 | null>(null);
  const [g2, setG2] = useState<Guess2 | null>(null);
  const cur = usage(st);
  const f = st.found;
  const pct = (mib: number) => `${(mib / LIMIT) * 100}%`;
  const segs: { key: string; mib: number; cls: string; label: string }[] = [
    { key: "kernel", mib: KERNEL, cls: "kernel", label: "kernel" },
    ...PROCS.filter((p) => st.procs[p].alive).map((p) => ({ key: p, mib: st.procs[p].anon, cls: "anon " + p, label: PROC_INFO[p].name })),
    { key: "hot", mib: st.hot, cls: "hot", label: "hot cache" },
    { key: "cold", mib: st.cold, cls: "cold", label: "cold cache" },
  ];

  return (
    <PgFrame title="A container with memory.max = 1 GiB" onReset={() => { setG1(null); setG2(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess1>
        question={`The container's limit is ${LIMIT} MiB, and ${st.startCache} MiB of it is page cache. The API keeps allocating ${STEP} MiB at a time. What happens when memory.current reaches the limit?`}
        options={[{ value: "kill", label: "The OOM killer kills a process" }, { value: "cache", label: "The kernel drops page cache and the allocation succeeds" }, { value: "enomem", label: "malloc returns NULL" }]}
        value={g1} onChange={setG1} revealed={f.cacheFirst} answer="cache"
        explain={<>Clean page cache is the cheapest memory to take back: it is a copy of data already on disk. Reclaim dropped it and the allocation went through. The cache shrinking under a limit is normal; nothing leaked.</>}
      />
      {f.cacheFirst && (
        <PgPredict<Guess2>
          question="Keep going until nothing is left to reclaim. When the OOM killer runs, which process does it pick?"
          options={[{ value: "asker", label: "The one that asked for memory" }, { value: "largest", label: "The one using the most memory" }, { value: "newest", label: "The most recently started" }]}
          value={g2} onChange={setG2} revealed={!!st.firstKill || f.notTheAsker} answer="largest"
          explain={<>It scores every process in the group by resident plus swapped memory, adds oom_score_adj (per mille of the limit), and kills the highest. {st.firstKill ? <>Here {PROC_INFO[st.firstKill.asked].name} asked and {PROC_INFO[st.firstKill.victim].name} died.</> : null} Make the worker ask at the moment of the OOM to see the asker survive.</>}
        />
      )}

      <section className="oom-bar-wrap" aria-label="memory.current, broken down">
        <div className="oom-bar-head">
          <span className="label">memory.current {cur} MiB of memory.max {LIMIT} MiB</span>
          {st.highOn && <span className="label oom-high-label">memory.high {HIGH} MiB</span>}
        </div>
        <div className="oom-bar" role="img" aria-label={segs.map((s) => `${s.label} ${s.mib} MiB`).join(", ") + `, free ${LIMIT - cur} MiB`}>
          {segs.map((s) => s.mib > 0 && (
            <i key={s.key} className={"oom-seg " + s.cls + (reduced ? "" : " anim")} style={{ width: pct(s.mib) }} title={`${s.label}: ${s.mib} MiB`}>
              {s.mib >= 70 ? <span>{s.label}</span> : null}
            </i>
          ))}
          {st.highOn && <b className="oom-high" style={{ left: pct(HIGH) }} aria-hidden="true" />}
        </div>
        {st.swapOn && (
          <div className="oom-swap">
            <span className="label">swap {swapTotal(st)} of memory.swap.max {SWAP_MAX} MiB</span>
            <span className="oom-swap-track"><i style={{ width: `${(swapTotal(st) / SWAP_MAX) * 100}%` }} /></span>
          </div>
        )}
        <p className="oom-legend"><span className="anon" /> anonymous (heap) <span className="hot" /> page cache in use <span className="cold" /> page cache read once <span className="kernel" /> kernel</p>
      </section>

      <div className="oom-procs">
        {PROCS.map((p) => {
          const x = st.procs[p];
          return (
            <section key={p} className={"pg-side oom-proc" + (x.alive ? "" : " dead")} aria-label={PROC_INFO[p].name}>
              <header><h4>{PROC_INFO[p].name}</h4><span className={"pg-status" + (x.alive ? " done" : "")}>{x.alive ? "running" : `killed · exit ${x.exit}`}</span></header>
              <p className="muted">{PROC_INFO[p].role}</p>
              <dl className="oom-kv">
                <div><dt>anon</dt><dd>{x.anon} MiB</dd></div>
                {st.swapOn && <div><dt>swapped</dt><dd>{x.swapped} MiB</dd></div>}
                <div><dt>score</dt><dd>{x.alive ? score(st, p) : "–"}</dd></div>
              </dl>
              <div className="pg-actions">
                <PgButton primary disabled={!x.alive} onClick={() => dispatch({ type: "alloc", proc: p })}>+{STEP} MiB</PgButton>
                <PgButton disabled={!x.alive || x.anon < STEP} onClick={() => dispatch({ type: "free", proc: p })}>−{STEP}</PgButton>
              </div>
              <span className="label">oom_score_adj</span>
              <PgChoice label={`oom_score_adj for ${PROC_INFO[p].name}`} value={String(x.adj)} options={ADJ}
                onChange={(v) => dispatch({ type: "adj", proc: p, adj: Number(v) })} />
            </section>
          );
        })}
      </div>

      <div className="pg-actions">
        <PgButton disabled={!st.procs.shipper.alive} onClick={() => dispatch({ type: "read" })}>log-shipper reads {READ} MiB of logs</PgButton>
        <PgChoice<"off" | "on"> label="memory.high" value={st.highOn ? "on" : "off"} onChange={(v) => dispatch({ type: "high", on: v === "on" })}
          options={[{ value: "off", label: "memory.high max" }, { value: "on", label: `memory.high ${HIGH}M` }]} />
        <PgChoice<"off" | "on"> label="Swap" value={st.swapOn ? "on" : "off"} onChange={(v) => dispatch({ type: "swap", on: v === "on" })}
          options={[{ value: "off", label: "swap.max 0" }, { value: "on", label: `swap.max ${SWAP_MAX}M` }]} />
        {st.events.oom_kill > 0 && <PgButton onClick={() => dispatch({ type: "restart" })}>Restart the container</PgButton>}
      </div>

      {st.log.length > 0 && (
        <ul className="oom-log" aria-live="polite">
          {st.log.map((l, i) => <li key={i} className={l.kind}>{l.text}</li>)}
        </ul>
      )}

      <div className="oom-files">
        <pre aria-label="memory.events">{`$ cat memory.events
low ${st.events.low}
high ${st.events.high}
max ${st.events.max}
oom ${st.events.oom}
oom_kill ${st.events.oom_kill}`}</pre>
        <pre aria-label="memory.stat and friends">{`$ cat memory.current
${cur * 1048576}
$ grep -E '^(anon|file) ' memory.stat
anon ${PROCS.reduce((a, p) => a + (st.procs[p].alive ? st.procs[p].anon : 0), 0) * 1048576}
file ${(st.hot + st.cold) * 1048576}${swapMax(st) ? `
$ cat memory.swap.current
${swapTotal(st) * 1048576}` : ""}`}</pre>
      </div>

      <dl className="pg-stats">
        <div><dt>Page cache</dt><dd>{st.hot + st.cold} MiB</dd></div>
        <div><dt>Reclaimed</dt><dd>{st.reclaimedFile} MiB</dd></div>
        <div className={st.throttledMs ? "bad" : ""}><dt>Throttled</dt><dd>{st.throttledMs} ms</dd></div>
        <div className={st.events.oom_kill ? "bad" : ""}><dt>OOM kills</dt><dd>{st.events.oom_kill}</dd></div>
      </dl>

      {st.firstKill && (
        <div className="pg-result">
          <span className="label">Your container, in your numbers</span>
          <p>Before anyone died, reclaim gave back {st.reclaimedFile} MiB of page cache{st.hotEvicted ? `, ${st.hotEvicted} MiB of it pages the API was still using` : ""}{st.swappedOut ? `, and swapped ${st.swappedOut} MiB of heap out` : ""}. The cache went from {st.startCache} MiB to {st.cacheAtFirstKill} MiB. Then <b>{PROC_INFO[st.firstKill.asked].name}</b> asked for {STEP} MiB, and the OOM killer chose <b>{PROC_INFO[st.firstKill.victim].name}</b> (scores: {PROCS.map((p) => `${PROC_INFO[p].name} ${st.firstKill!.scores[p]}`).join(", ")}).</p>
          <p className="pg-takeaway">A limit is reached in stages: cache first, then swap if allowed, then a kill. The victim is the biggest by memory plus oom_score_adj, whoever asked. To choose who dies, set oom_score_adj; to slow down instead of dying, set memory.high below memory.max.</p>
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="oom-goals">
          <li className={f.cacheFirst ? "done" : ""}>{f.cacheFirst ? "✓" : "○"} Reach the limit and watch the page cache shrink instead of a kill.</li>
          <li className={f.notTheAsker ? "done" : ""}>{f.notTheAsker ? "✓" : "○"} Have one process ask and another one die.</li>
          <li className={f.steered ? "done" : ""}>{f.steered ? "✓" : "○"} Make the OOM killer spare the API, using oom_score_adj.</li>
          <li className={f.throttled ? "done" : ""}>{f.throttled ? "✓" : "○"} Turn on memory.high and get throttled for half a second without a kill.</li>
          <li className={f.swapSaved ? "done" : ""}>{f.swapSaved ? "✓" : "○"} Allow swap and push heap out of RAM.</li>
        </ul>
      </div>

      <p className="oom-how"><span className="label">In your language</span> {HOW[lang]}</p>

      <PgSources links={[
        { title: "the kernel's cgroup v2 memory controller docs", href: "https://docs.kernel.org/admin-guide/cgroup-v2.html" },
        { title: "Chris Down's In defence of swap", href: "https://chrisdown.name/2018/01/02/in-defence-of-swap.html" },
        { title: "Mel Gorman's chapter on out-of-memory management", href: "https://www.kernel.org/doc/gorman/html/understand/understand016.html" },
      ]} />

      <style>{`
        .oom-bar-wrap { display: grid; gap: 6px; }
        .oom-bar-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; }
        .oom-high-label { color: var(--pain); }
        .oom-bar { position: relative; display: flex; height: 34px; border: 1px solid var(--ink-2); background: repeating-linear-gradient(90deg, var(--surface) 0 15px, var(--grid) 15px 16px); overflow: hidden; }
        .oom-seg { display: flex; align-items: center; justify-content: center; height: 100%; overflow: hidden; border-right: 1px solid var(--surface); font-style: normal; }
        .oom-seg.anim { transition: width .35s var(--ease); }
        .oom-seg span { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; white-space: nowrap; color: var(--accent-ink); }
        .oom-seg.kernel, .oom-legend .kernel { background: var(--ink-2); }
        .oom-seg.anon, .oom-legend .anon { background: var(--accent); }
        .oom-seg.anon.worker { opacity: .8; }
        .oom-seg.anon.shipper { opacity: .62; }
        .oom-seg.hot, .oom-legend .hot { background: var(--good); }
        .oom-seg.cold, .oom-legend .cold { background: var(--hl); }
        .oom-seg.cold span, .oom-seg.hot span { color: var(--ink); }
        .oom-high { position: absolute; top: -2px; bottom: -2px; width: 0; border-left: 2px dashed var(--pain); }
        .oom-legend { margin: 0; font-size: .78rem; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .oom-legend span { display: inline-block; width: 10px; height: 10px; border: 1px solid var(--line); }
        .oom-swap { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: center; }
        .oom-swap-track { height: 10px; border: 1px solid var(--line); background: var(--surface); }
        .oom-swap-track i { display: block; height: 100%; background: var(--pain); }
        .oom-procs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
        .oom-proc { display: grid; gap: 6px; align-content: start; }
        .oom-proc.dead { border-color: var(--pain); background: var(--pain-bg); }
        .oom-kv { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; }
        .oom-kv div { display: flex; gap: 4px; align-items: baseline; }
        .oom-kv dt { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; color: var(--ink-2); }
        .oom-kv dd { margin: 0; font-family: var(--f-code); font-size: .85rem; font-variant-numeric: tabular-nums; }
        .oom-proc .pg-choice button { font-size: .7rem; padding: 2px 5px; }
        .oom-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: .86rem; }
        .oom-log li { border-left: 3px solid var(--line); padding: 2px 8px; }
        .oom-log li.reclaim, .oom-log li.read { border-color: var(--good); }
        .oom-log li.swap, .oom-log li.throttle { border-color: var(--accent); }
        .oom-log li.oom, .oom-log li.kill, .oom-log li.fail { border-color: var(--pain); color: var(--pain); }
        .oom-files { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 8px; }
        .oom-files pre { margin: 0; font-family: var(--f-code); font-size: .74rem; background: var(--surface); border: 1px solid var(--line); padding: 6px 8px; overflow-x: auto; }
        .oom-goals { list-style: none; padding-left: 0 !important; }
        .oom-goals li.done { color: var(--good); }
        .oom-how { margin: 0; font-size: .92rem; }
        @media (max-width: 720px) {
          .oom-procs, .oom-files { grid-template-columns: 1fr; }
        }
        @media (prefers-reduced-motion: reduce) { .oom-seg.anim { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
