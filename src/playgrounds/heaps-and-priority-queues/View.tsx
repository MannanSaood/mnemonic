"use client";
import { useEffect, useState } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, MAX_JOBS, depth, init, parent, step, trueMin, violations,
  type Bench, type Job, type State,
} from "./model";

const W = 560, ROW = 50, TOP = 22, R = 15;
const pos = (i: number) => {
  const d = depth(i), first = 2 ** d - 1, slots = 2 ** d;
  return { x: ((i - first + 0.5) * W) / slots, y: TOP + d * ROW };
};
const n0 = (x: number) => x.toLocaleString("en");

function Tree({ heap, hi, st, onPick }: { heap: Job[]; hi: number[]; st: State; onPick: (i: number) => void }) {
  const bad = new Set(violations(heap).map(([, c]) => c));
  const levels = heap.length ? depth(heap.length - 1) + 1 : 1;
  const H = TOP + (levels - 1) * ROW + R + 8;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="hp-tree" role="group" aria-label={`Heap as a tree, ${heap.length} jobs, ${levels} levels`}>
      {heap.map((_, i) => {
        if (i === 0) return null;
        const a = pos(parent(i)), b = pos(i);
        return <line key={`e${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={bad.has(i) ? "hp-edge bad" : "hp-edge"} />;
      })}
      {heap.map((j, i) => {
        const p = pos(i);
        const cls = ["hp-node", hi.includes(i) ? "hi" : "", st.selected === i ? "sel" : "", bad.has(i) ? "bad" : ""].join(" ");
        return (
          <g key={`n${i}`} className={cls} transform={`translate(${p.x},${p.y})`} role="button" tabIndex={0}
            aria-label={`Index ${i}: ${j.name}, priority ${j.prio}`}
            onClick={() => onPick(i)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(i); } }}>
            <title>{`${j.name} · priority ${j.prio} · index ${i}`}</title>
            <circle r={R} />
            <text y={4} textAnchor="middle">{j.prio}</text>
          </g>
        );
      })}
    </svg>
  );
}

function ArrayRow({ heap, hi }: { heap: Job[]; hi: number[] }) {
  return (
    <div className="hp-array" aria-label="The same heap as an array">
      {Array.from({ length: Math.max(heap.length, 1) }, (_, i) => (
        <span key={i} className={"hp-cell" + (hi.includes(i) ? " hi" : "") + (heap[i] ? "" : " empty")}>
          <b>{heap[i]?.prio ?? ""}</b><i>{i}</i>
        </span>
      ))}
    </div>
  );
}

function BenchTable({ b }: { b: Bench }) {
  const ratio = b.heapMoves ? b.sortedMoves / b.heapMoves : 0;
  return (
    <div className="hp-bench">
      <p>{b.kind === "queue"
        ? `Push ${n0(b.n)} jobs with random priorities, then dispatch all of them.`
        : `Stream ${n0(b.n)} request latencies and keep the ${b.k} slowest.`}</p>
      <dl className="pg-stats">
        <div><dt>Heap · moves</dt><dd>{n0(b.heapMoves)}</dd></div>
        <div className={ratio >= 10 ? "bad" : ""}><dt>Sorted list · moves</dt><dd>{n0(b.sortedMoves)}</dd></div>
        <div><dt>Ratio</dt><dd>{ratio.toFixed(0)}×</dd></div>
        <div><dt>{b.kind === "queue" ? "Compares heap / list" : "Sort all · compares"}</dt><dd>{b.kind === "queue" ? `${n0(b.heapCompares)} / ${n0(b.sortedCompares)}` : n0(b.sortAllCompares)}</dd></div>
      </dl>
    </div>
  );
}

function lastLine(st: State): string {
  const l = st.last;
  if (!l || !l.job) return "Push a job or dispatch the next one. Click a node to change its priority.";
  if (l.kind === "push") return `Pushed ${l.job.name} (${l.job.prio}). The heap moved ${l.moves} job${l.moves === 1 ? "" : "s"}${l.levels ? `, climbing ${l.levels} level${l.levels === 1 ? "" : "s"}` : ""}; the sorted list shifted ${l.sortedMoves} to make room.`;
  if (l.kind === "pop") return l.wrong
    ? `Dispatched ${l.job.name} (${l.job.prio}), but ${l.wrong.name} (${l.wrong.prio}) was more urgent. The broken rule hid it below the root, and nothing in the heap checks.`
    : `Dispatched ${l.job.name} (${l.job.prio}), the root. Refilling the root took ${l.moves} move${l.moves === 1 ? "" : "s"} down one path.`;
  if (l.kind === "urgent") return `${l.job.name} became priority 1 and sifted up ${l.levels} level${l.levels === 1 ? "" : "s"} in ${l.moves} move${l.moves === 1 ? "" : "s"}.`;
  return `${l.job.name} became priority 1 in place, with no sift. The heap does not know. Dispatch and see what comes out.`;
}

export default function HeapPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [f, setF] = useState(0);
  const [prio, setPrio] = useState(25);
  const frames = st.frames;
  useEffect(() => {
    if (reduced || frames.length < 2) { setF(Math.max(0, frames.length - 1)); return; }
    setF(0);
    let i = 0;
    const t = setInterval(() => { i++; setF(i); if (i >= frames.length - 1) clearInterval(t); }, 650);
    return () => clearInterval(t);
  }, [frames, reduced]);
  const playing = frames.length > 0 && f < frames.length - 1;
  const fr = frames[Math.min(f, frames.length - 1)];
  const shown = playing && fr ? fr.heap : st.heap;
  const hi = fr && (playing || f === frames.length - 1) ? fr.hi : [];
  const bad = violations(st.heap);
  const sel = st.selected !== null ? st.heap[st.selected] : null;
  const next = trueMin(st.heap);
  const full = st.heap.length >= MAX_JOBS;
  const queue10k = st.bench?.kind === "queue" && st.bench.n === 10000;

  return (
    <PgFrame title="A job scheduler's priority queue" onReset={() => { setF(0); dispatch({ type: "reset" }); }}>
      <PgPredict
        question="Push 10,000 jobs with random priorities, then dispatch all of them. A heap moves jobs up and down one path; a sorted list shifts jobs to keep its order. How many more moves does the sorted list make?"
        options={[{ value: "1", label: "About the same" }, { value: "10", label: "About 10× more" }, { value: "100", label: "Over 100× more" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={queue10k}
        answer="100"
        explain={<>{st.bench && queue10k ? `${n0(st.bench.sortedMoves)} against ${n0(st.bench.heapMoves)}. ` : ""}A sorted insert shifts every job after the insertion point, about n/2 per push, so n pushes cost about n²/4. A heap push or pop moves at most one job per level, log₂ n, and a random push usually stops after a level or two. The gap grows with n: about 25× at 1,000 jobs, about 190× at 10,000.</>}
      />

      <div className="pg-req">
        <span className="label">Queue · {st.heap.length} of {MAX_JOBS} jobs · lower number = more urgent</span>
        <div className="pg-actions hp-actions">
          <label className="hp-prio">Priority
            <input type="number" min={1} max={99} value={prio} onChange={(e) => setPrio(Number(e.target.value) || 1)} />
          </label>
          <PgButton primary onClick={() => dispatch({ type: "push", prio })} disabled={full}>Push job</PgButton>
          <PgButton onClick={() => dispatch({ type: "push" })} disabled={full}>Push random</PgButton>
          <PgButton onClick={() => dispatch({ type: "pop" })} disabled={!st.heap.length}>Dispatch next</PgButton>
        </div>
        {sel && st.selected !== null && (
          <div className="hp-sel">
            <span className="pg-place">Index {st.selected}: {sel.name} · priority {sel.prio}</span>
            <div className="pg-actions">
              <PgButton onClick={() => dispatch({ type: "urgent", index: st.selected! })}>Make urgent, then sift</PgButton>
              <button className="pg-btn hp-break" onClick={() => dispatch({ type: "corrupt", index: st.selected! })}>Make urgent without sifting (break it)</button>
            </div>
          </div>
        )}
      </div>

      <div className="pg-card">
        <span className="label">The heap · tree view and the array it really is · children of i are 2i+1 and 2i+2</span>
        <Tree heap={shown} hi={hi} st={st} onPick={(i) => dispatch({ type: "select", index: st.selected === i ? null : i })} />
        <ArrayRow heap={shown} hi={hi} />
        <p className="hp-note" aria-live="polite">{playing && fr ? fr.note : lastLine(st)}</p>
        {frames.length > 1 && (
          <div className="pg-actions hp-steps">
            <PgButton onClick={() => setF(Math.max(0, f - 1))} disabled={f === 0}>◀ Step</PgButton>
            <span className="pg-place">Step {Math.min(f, frames.length - 1) + 1} of {frames.length}</span>
            <PgButton onClick={() => setF(Math.min(frames.length - 1, f + 1))} disabled={f >= frames.length - 1}>Step ▶</PgButton>
          </div>
        )}
        {bad.length > 0 && <p className="hp-warn">The heap rule is broken at {bad.length} place{bad.length === 1 ? "" : "s"} (red edges). The root is {st.heap[0]?.prio}; the most urgent job is {next?.prio}.</p>}
      </div>

      <div className="pg-sides">
        <div className="pg-side">
          <header><h4>Heap</h4><span className="pg-status done">{n0(st.heapMoves)} moves</span></header>
          <p className="muted">Each push or pop moves at most one job per level: {st.heap.length ? depth(st.heap.length - 1) + 1 : 0} levels now.</p>
          <dl className="pg-stats hp-stats">
            <div><dt>Ops</dt><dd>{st.ops}</dd></div>
            <div><dt>Last op</dt><dd>{st.last ? st.last.moves : "-"}</dd></div>
            <div className={st.wrong ? "bad" : ""}><dt>Wrong dispatches</dt><dd>{st.wrong}</dd></div>
          </dl>
        </div>
        <div className="pg-side">
          <header><h4>Sorted list</h4><span className={"pg-status" + (st.sortedMoves <= st.heapMoves ? " done" : "")}>{n0(st.sortedMoves)} moves</span></header>
          <div className="hp-list" aria-label="The same jobs in a sorted list, most urgent last">
            {st.sorted.map((j, i) => <span key={j.id} className={i === st.sorted.length - 1 ? "next" : ""}>{j.prio}</span>)}
          </div>
          <p className="muted">Most urgent last, so a dispatch moves nothing, but a push shifts everything after its place.</p>
        </div>
      </div>

      <div className="pg-req">
        <span className="label">Load test · counts only</span>
        <div className="pg-actions">
          <PgButton onClick={() => dispatch({ type: "bench", kind: "queue", n: 1000 })}>Scheduler · 1,000 jobs</PgButton>
          <PgButton primary onClick={() => dispatch({ type: "bench", kind: "queue", n: 10000 })}>Scheduler · 10,000 jobs</PgButton>
          <PgButton onClick={() => dispatch({ type: "bench", kind: "topk", n: 100000 })}>Top 100 of 100,000 latencies</PgButton>
        </div>
        {st.bench ? <BenchTable b={st.bench} /> : <p className="muted">Run a workload through both structures and compare how many jobs each one moves.</p>}
      </div>

      <div className="pg-req">
        <span className="label">Challenges: {CHALLENGES.filter((c) => st.done[c.id]).length} of {CHALLENGES.length}</span>
        <ul className="hp-ch">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "got" : ""}><span aria-hidden="true">{st.done[c.id] ? "■" : "□"}</span> {c.text}</li>)}
        </ul>
      </div>

      {(st.ops >= 5 || st.bench) && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your queue cost</span>
          <p>
            {st.ops} pushes and dispatches: the heap moved {n0(st.heapMoves)} jobs, the sorted list {n0(st.sortedMoves)}.
            {st.bench ? ` In your load test the sorted list moved ${n0(st.bench.sortedMoves)} jobs to the heap's ${n0(st.bench.heapMoves)}.` : ""}
            {st.wrong ? ` ${st.wrong} dispatch${st.wrong === 1 ? " was" : "es were"} the wrong job.` : ""}
          </p>
          <p className="pg-takeaway">
            {st.wrong
              ? "A heap only promises that each parent beats its children. Change a priority in place without sifting and that promise breaks silently: the root is no longer the minimum. Update through the heap (Go's heap.Fix), or push a new entry and skip the stale one when it comes out."
              : "The heap never sorts. It keeps one rule per parent and child, which is enough to keep the next job at index 0, and each repair walks a single path of log₂ n levels. That is why schedulers, timers and top-k use a heap and not a sorted list."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "VisuAlgo's binary heap", href: "https://visualgo.net/en/heap" },
        { title: "David Galles' heap visualisation (USF)", href: "https://www.cs.usfca.edu/~galles/visualization/Heap.html" },
        { title: "the Python heapq documentation's priority queue notes", href: "https://docs.python.org/3/library/heapq.html" },
      ]} />

      <style>{CSS}</style>
    </PgFrame>
  );
}

const CSS = `
.hp-actions { align-items: center; }
.hp-prio { display: inline-flex; gap: 6px; align-items: center; font-family: var(--f-code); font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.hp-prio input { width: 4.5em; font: inherit; font-size: .9rem; padding: 3px 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
.hp-sel { display: grid; gap: 6px; border-top: 1px dashed var(--line); padding-top: 8px; }
.hp-break { color: var(--pain); }
.hp-tree { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 12px 12px; }
.hp-edge { stroke: var(--line); stroke-width: 1.5; }
.hp-edge.bad { stroke: var(--pain); stroke-width: 2.5; }
.hp-node { cursor: pointer; }
.hp-node circle { fill: var(--surface); stroke: var(--ink-2); stroke-width: 1.5; transition: fill .2s var(--ease); }
.hp-node text { font-family: var(--f-code); font-size: 12px; font-weight: 700; fill: var(--ink); pointer-events: none; }
.hp-node.hi circle { fill: var(--hl); stroke: var(--accent); stroke-width: 2.5; }
.hp-node.sel circle { stroke: var(--ink); stroke-width: 3; }
.hp-node.bad circle { stroke: var(--pain); fill: var(--pain-bg); }
.hp-node:focus-visible { outline: none; }
.hp-node:focus-visible circle { stroke: var(--accent); stroke-width: 3; }
.hp-array { display: grid; grid-template-columns: repeat(16, minmax(0, 1fr)); gap: 2px; }
.hp-cell { border: 1px solid var(--line); background: var(--surface); display: grid; text-align: center; padding: 2px 0; min-width: 0; }
.hp-cell b { font-family: var(--f-code); font-size: .78rem; }
.hp-cell i { font-style: normal; font-family: var(--f-code); font-size: .55rem; color: var(--ink-2); }
.hp-cell.hi { background: var(--hl); border-color: var(--accent); }
.hp-cell.empty { visibility: hidden; }
.hp-note { margin: 0; font-size: .92rem; min-height: 2.6em; }
.hp-steps { align-items: center; }
.hp-warn { margin: 0; color: var(--pain); font-size: .92rem; }
.hp-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.hp-list { display: flex; flex-wrap: wrap; gap: 2px; }
.hp-list span { font-family: var(--f-code); font-size: .7rem; padding: 1px 4px; border: 1px solid var(--line); background: var(--surface); }
.hp-list span.next { border-color: var(--accent); background: var(--hl); }
.hp-bench { display: grid; gap: 6px; }
.hp-bench p { margin: 0; }
.hp-ch { list-style: none; padding-left: 0 !important; }
.hp-ch li.got { color: var(--good); }
@media (max-width: 520px) { .hp-array { grid-template-columns: repeat(8, minmax(0, 1fr)); } .hp-node text { font-size: 14px; } }
@media (prefers-reduced-motion: reduce) { .hp-node circle { transition: none; } }
`;
