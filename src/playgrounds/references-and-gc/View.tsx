"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  COLLECT_EVERY, NIGHTS, PDF_MB, PROGRAMS, PROGS, heapAt, linesOf, nightly, reachable, refcount, stats, step, init,
  type Heap, type ProgId, type State,
} from "./model";

const CSS = `
.rgc-code { display: grid; border: 1px solid var(--line); background: var(--surface); }
.rgc-line { display: grid; grid-template-columns: 2.2em 1fr; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--line); padding: 3px 6px 3px 0; font: inherit; color: var(--ink); cursor: pointer; }
.rgc-line:last-child { border-bottom: 0; }
.rgc-line:hover { background: var(--hl); }
.rgc-line .n { font-family: var(--f-code); font-size: .65rem; color: var(--ink-2); text-align: right; padding-right: 8px; padding-top: 2px; }
.rgc-line pre { margin: 0; font-family: var(--f-code); font-size: .78rem; white-space: pre-wrap; word-break: break-word; }
.rgc-line.done { color: var(--ink-2); }
.rgc-line.cur { background: var(--hl); box-shadow: inset 3px 0 0 var(--accent); color: var(--ink); }
.rgc-line .res { font-family: var(--f-code); font-size: .72rem; color: var(--accent); }
.rgc-note { margin: 0; font-size: .95rem; }
.rgc-heap { width: 100%; height: auto; background: var(--surface); border: 1px solid var(--line); color: var(--ink-2); }
.rgc-col { font-family: var(--f-code); font-size: 8px; letter-spacing: .08em; text-transform: uppercase; fill: var(--ink-2); }
.rgc-box { fill: var(--bg); stroke: var(--line); stroke-width: 1; }
.rgc-box.var { fill: var(--surface-2); }
.rgc-box.lost { fill: var(--pain-bg); stroke: var(--pain); stroke-width: 2; }
.rgc-head { fill: var(--surface-2); }
.rgc-t { font-family: var(--f-code); font-size: 10px; fill: var(--ink); }
.rgc-t.b { font-weight: 700; }
.rgc-t.dim { fill: var(--ink-2); }
.rgc-t.bad { fill: var(--pain); font-weight: 700; }
.rgc-rc { fill: var(--accent); }
.rgc-rc-t { font-family: var(--f-code); font-size: 9px; fill: var(--accent-ink); font-weight: 700; }
.rgc-ref { fill: none; stroke: currentColor; stroke-width: 1.3; }
.rgc-ref.weak { stroke-dasharray: 3 3; opacity: .7; }
.rgc-ref.lost { stroke: var(--pain); color: var(--pain); }
.rgc-heap.anim .rgc-box, .rgc-heap.anim .rgc-ref { transition: all .25s var(--ease); }
.rgc-bars { display: flex; align-items: flex-end; gap: 1px; height: 70px; border-bottom: 1px solid var(--line); }
.rgc-bars i { flex: 1; background: var(--accent); min-height: 1px; }
.rgc-bars.bad i { background: var(--pain); }
.rgc-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
.rgc-table th, .rgc-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
.rgc-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.rgc-table td.bad { color: var(--pain); font-weight: 600; }
.rgc-scroll { overflow-x: auto; }
@media (prefers-reduced-motion: reduce) { .rgc-heap .rgc-box, .rgc-heap .rgc-ref { transition: none; } }
`;

/* ---------------- the heap, Python Tutor style ---------------- */

const SLOT = 15, HEAD = 18, COLX = [130, 352], COLW = [196, 200], NAMEW = 84;

function layout(h: Heap) {
  // Columns by distance from the names; unreachable objects start their own column-0 chain.
  const level = new Map<number, number>();
  const visit = (roots: number[]) => {
    const todo = roots.map((id) => [id, 0] as [number, number]);
    while (todo.length) {
      const [id, d] = todo.shift()!;
      if (level.has(id) || !h.objs[id]) continue;
      level.set(id, d);
      for (const s of h.objs[id].slots) if ("ref" in s.v) todo.push([s.v.ref, d + 1]);
    }
  };
  visit(h.names.map((n) => n.to));
  for (const id of Object.keys(h.objs).map(Number).sort((a, b) => a - b)) if (!level.has(id)) visit([id]);
  const pos: Record<number, { x: number; y: number; w: number; hgt: number }> = {};
  const ys = [24, 24];
  for (const id of Object.keys(h.objs).map(Number).sort((a, b) => a - b)) {
    const col = Math.min(1, level.get(id) ?? 0);
    const hgt = HEAD + Math.max(1, h.objs[id].slots.length) * SLOT + 4;
    pos[id] = { x: COLX[col], y: ys[col], w: COLW[col], hgt };
    ys[col] += hgt + 14;
  }
  const nameY = (i: number) => 24 + i * 34;
  const height = Math.max(ys[0], ys[1], nameY(h.names.length), 120) + 4;
  return { pos, nameY, height };
}

function curve(x1: number, y1: number, x2: number, y2: number, back: boolean) {
  if (!back) { const m = (x1 + x2) / 2; return `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`; }
  const bend = Math.max(x1, x2) + 34;
  return `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`;
}

function HeapView({ h, reduced }: { h: Heap; reduced: boolean }) {
  const { pos, nameY, height } = layout(h);
  const live = reachable(h);
  const ids = Object.keys(h.objs).map(Number).sort((a, b) => a - b);
  const label = h.names.length || ids.length
    ? `Names: ${h.names.map((n) => `${n.name} refers to object ${n.to}`).join(", ") || "none"}. Objects: ${ids.map((id) => `${h.objs[id].type} with refcount ${refcount(h, id)}${live.has(id) ? "" : ", unreachable"}`).join("; ")}.`
    : "The heap is empty.";
  return (
    <svg className={"rgc-heap" + (reduced ? "" : " anim")} viewBox={`0 0 580 ${height}`} role="img" aria-label={label}>
      <defs>
        <marker id="rgc-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker>
      </defs>
      <text x="8" y="12" className="rgc-col">names</text>
      <text x={COLX[0]} y="12" className="rgc-col">objects · refcount in the badge</text>
      {/* references first, boxes on top */}
      {h.names.map((n, i) => {
        const t = pos[n.to];
        return t ? <path key={"n" + n.name} className="rgc-ref" d={curve(8 + NAMEW, nameY(i) + 12, t.x, t.y + 9, false)} markerEnd="url(#rgc-arrow)" /> : null;
      })}
      {ids.flatMap((id) => h.objs[id].slots.map((s, j) => {
        if (!("ref" in s.v)) return null;
        const from = pos[id], t = pos[s.v.ref];
        if (!t) return null;
        const x1 = from.x + from.w - 4, y1 = from.y + HEAD + j * SLOT + 9;
        const back = t.x <= from.x;
        const x2 = back ? t.x + t.w : t.x;
        return <path key={`r${id}-${j}`} className={"rgc-ref" + (s.v.weak ? " weak" : "") + (live.has(id) ? "" : " lost")} d={curve(x1, y1, x2, t.y + 9, back)} markerEnd="url(#rgc-arrow)" />;
      }))}
      {h.names.map((n, i) => (
        <g key={n.name}>
          <rect x="8" y={nameY(i)} width={NAMEW} height="24" className="rgc-box var" />
          <text x={8 + NAMEW / 2} y={nameY(i) + 16} textAnchor="middle" className="rgc-t">{n.name}</text>
        </g>
      ))}
      {ids.map((id) => {
        const o = h.objs[id], p = pos[id], lost = !live.has(id), rc = refcount(h, id);
        return (
          <g key={id}>
            <rect x={p.x} y={p.y} width={p.w} height={p.hgt} className={"rgc-box" + (lost ? " lost" : "")} />
            <rect x={p.x + 1} y={p.y + 1} width={p.w - 2} height={HEAD - 2} className="rgc-head" />
            <text x={p.x + 6} y={p.y + 13} className="rgc-t b">{o.type}</text>
            {lost && <text x={p.x + p.w - 30} y={p.y + 13} textAnchor="end" className="rgc-t bad">unreachable</text>}
            <rect x={p.x + p.w - 24} y={p.y + 3} width="20" height="12" className="rgc-rc" />
            <text x={p.x + p.w - 14} y={p.y + 12.5} textAnchor="middle" className="rgc-rc-t">{rc}</text>
            {o.slots.length === 0 && <text x={p.x + 6} y={p.y + HEAD + 11} className="rgc-t dim">(empty)</text>}
            {o.slots.map((s, j) => (
              <text key={j} x={p.x + 6} y={p.y + HEAD + j * SLOT + 11} className="rgc-t">
                <tspan className="rgc-t dim">{s.key}: </tspan>{"text" in s.v ? s.v.text : s.v.weak ? "⇢" : "●"}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

/* ---------------- the page ---------------- */

const GUESSES: Record<ProgId, { q: string; options: { value: string; label: string }[]; answer: string; explain: string }> = {
  defaults: {
    q: "As written: after b = recipients(\"ben@shop.io\"), what does a hold?",
    options: [{ value: "one", label: "['ana@shop.io']" }, { value: "both", label: "['ana@shop.io', 'ben@shop.io']" }, { value: "error", label: "TypeError" }],
    answer: "both",
    explain: "The default list is created once, when def runs, and every call that omits cc appends to it. a and b are two names for that one list.",
  },
  rota: {
    q: "As written: after rota[0][0] = \"ana\", what is rota[2][0]?",
    options: [{ value: "dash", label: "'-'" }, { value: "ana", label: "'ana'" }, { value: "index", label: "IndexError" }],
    answer: "ana",
    explain: "* 3 repeats the reference to the one row list. Every day is the same row, so a change to Monday is a change to Wednesday.",
  },
  cycle: {
    q: "As written: after del run, is the InvoiceRun (and its 40 MB of PDFs) freed?",
    options: [{ value: "yes", label: "Yes, nothing names it" }, { value: "gc", label: "Only when the cycle collector runs" }, { value: "never", label: "Never" }],
    answer: "gc",
    explain: "The bound method stored in run.on_error refers back to run, so the count never reaches zero. The cycle collector finds the pair unreachable and frees it, whenever it next runs.",
  },
};

const TAKEAWAY: Record<ProgId, string> = {
  defaults: "As written, two calls returned one list that the function kept between calls. With a None default, each call built its own. A default value is evaluated once, at def time, and shared.",
  rota: "As written, the outer list held three references to one row. The comprehension built three rows. Multiplying a list copies references, never the objects they point to.",
  cycle: "As written, del left the run alive with a refcount of 1 until gc.collect(). With WeakMethod it was freed on the del line. Reference counting frees most objects at once; cycles wait for the collector.",
};

function Loop({ st, dispatch }: { st: State; dispatch: (a: import("./model").Action) => void }) {
  const last = st.loops[st.loops.length - 1];
  const held = last ? nightly(last.design, last.gcOn) : null;
  const max = NIGHTS * PDF_MB;
  return (
    <div className="pg-card">
      <span className="label">Break it: run the nightly job {NIGHTS} times</span>
      <p className="pg-note">Each run makes an InvoiceRun with {PDF_MB} MB of PDFs and drops it when done. Some services call gc.disable() to avoid collector pauses. The model runs a collection every {COLLECT_EVERY} runs; CPython triggers one by allocation counts.</p>
      <PgChoice<"on" | "off"> label="Cycle collector" value={st.loopGc ? "on" : "off"} onChange={(v) => dispatch({ type: "loopGc", on: v === "on" })}
        options={[{ value: "on", label: "gc enabled" }, { value: "off", label: "gc.disable()" }]} />
      <div className="pg-actions">
        <PgButton primary onClick={() => dispatch({ type: "loop", design: "cycle" })}>Run {NIGHTS}× with the cycle</PgButton>
        <PgButton onClick={() => dispatch({ type: "loop", design: "weak" })}>Run {NIGHTS}× with WeakMethod</PgButton>
      </div>
      {held && last && (
        <>
          <div className={"rgc-bars" + (last.end > 0 ? " bad" : "")} role="img" aria-label={`Memory held by finished runs after each of ${NIGHTS} runs, peak ${last.peak} MB, at the end ${last.end} MB.`}>
            {held.map((mb, i) => <i key={i} style={{ height: `${(mb / max) * 100}%` }} />)}
          </div>
          <p className="pg-note">{last.design === "weak" ? "WeakMethod" : "Cycle"}, {last.gcOn ? "gc enabled" : "gc.disable()"}: finished runs held {last.peak} MB at the peak and {last.end} MB at the end.</p>
        </>
      )}
      {st.loops.length > 1 && (
        <div className="rgc-scroll">
          <table className="rgc-table">
            <thead><tr><th>Design</th><th>Collector</th><th>Peak held</th><th>After {NIGHTS} runs</th></tr></thead>
            <tbody>
              {st.loops.map((l) => (
                <tr key={l.design + l.gcOn}><th scope="row">{l.design === "weak" ? "WeakMethod" : "cycle"}</th><td>{l.gcOn ? "on" : "off"}</td><td className={l.peak ? "bad" : ""}>{l.peak} MB</td><td className={l.end ? "bad" : ""}>{l.end} MB</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ReferencesAndGc() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const lines = linesOf(st);
  const h = heapAt(st.prog, st.fixed, st.pc);
  const s = stats(h);
  const g = GUESSES[st.prog];
  const cur = st.pc > 0 ? lines[st.pc - 1] : null;
  const bothDone = st.finished.includes(`${st.prog}:bug`) && st.finished.includes(`${st.prog}:fixed`);
  const lastFreed = cur ? heapAt(st.prog, st.fixed, st.pc).freed.slice(heapAt(st.prog, st.fixed, st.pc - 1).freed.length) : [];

  return (
    <PgFrame title="Names, objects and refcounts" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">Run each program a line at a time and watch the heap. A name is an arrow to an object; the badge on each object is its reference count. <b>Find out which lines copy something, and which only add an arrow.</b></p>

      <div className="pg-card">
        <span className="label">Program</span>
        <PgChoice<ProgId> label="Program" value={st.prog} onChange={(p) => dispatch({ type: "prog", prog: p })}
          options={PROGS.map((p) => ({ value: p, label: PROGRAMS[p].title }))} />
        <PgChoice<"bug" | "fixed"> label="Version" value={st.fixed ? "fixed" : "bug"} onChange={(v) => dispatch({ type: "fixed", fixed: v === "fixed" })}
          options={[{ value: "bug", label: "As written" }, { value: "fixed", label: "Fixed" }]} />
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Code · click a line to run up to it</span>
          <div className="rgc-code">
            {lines.map((l, i) => (
              <button key={i} className={"rgc-line" + (i < st.pc - 1 ? " done" : i === st.pc - 1 ? " cur" : "")} onClick={() => dispatch({ type: "runTo", pc: i + 1 })} aria-label={`Run up to line ${i + 1}: ${l.code}`}>
                <span className="n">{i + 1}</span>
                <span>
                  <pre>{l.code}</pre>
                  {i < st.pc && l.result && <span className="res">→ {l.result}</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="pg-actions">
            <PgButton primary onClick={() => dispatch({ type: "next" })} disabled={st.pc >= lines.length}>Run next line</PgButton>
            <PgButton onClick={() => dispatch({ type: "back" })} disabled={st.pc === 0}>Step back</PgButton>
          </div>
          <p className="rgc-note" aria-live="polite">
            {cur ? cur.note : "Nothing has run yet."}
            {lastFreed.length > 0 && <> <b>Freed on this line:</b> {lastFreed.map((f) => `${f.type} (${f.by === "gc" ? "by the cycle collector" : "refcount reached 0"})`).join(", ")}.</>}
          </p>
        </div>
        <div className="pg-card">
          <PgPredict<string>
            question={g.q}
            options={g.options}
            value={st.guesses[st.prog] ?? null}
            onChange={(v) => dispatch({ type: "guess", value: v })}
            revealed={!st.fixed && st.pc >= PROGRAMS[st.prog].ask}
            answer={g.answer}
            explain={g.explain}
          />
        </div>
      </div>

      <div className="pg-card">
        <span className="label">The heap</span>
        <HeapView h={h} reduced={reduced} />
        <dl className="pg-stats">
          <div><dt>Names</dt><dd>{h.names.length}</dd></div>
          <div><dt>Live objects</dt><dd>{s.objects}</dd></div>
          <div className={s.unreachable ? "bad" : ""}><dt>Unreachable, still alive</dt><dd>{s.unreachable}{s.stuckMb ? ` · ${s.stuckMb} MB` : ""}</dd></div>
          <div><dt>Freed by refcount</dt><dd>{s.byRefcount}</dd></div>
          <div><dt>Freed by gc</dt><dd>{s.byGc}</dd></div>
        </dl>
      </div>

      {st.prog === "cycle" && <Loop st={st} dispatch={dispatch} />}

      {bothDone && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What you saw</span>
          <p className="pg-takeaway">{TAKEAWAY[st.prog]}</p>
        </div>
      )}
      {!bothDone && st.finished.includes(`${st.prog}:bug`) && (
        <p className="pg-note">Now switch to Fixed and run the same lines: same input, different heap.</p>
      )}

      <PgSources links={[
        { title: "Python Tutor's heap diagrams", href: "https://pythontutor.com/" },
        { title: "Ned Batchelder, Facts and myths about Python names and values", href: "https://nedbatchelder.com/text/names.html" },
        { title: "CPython's garbage collector design notes", href: "https://github.com/python/cpython/blob/main/InternalDocs/garbage_collector.md" },
      ]} />
    </PgFrame>
  );
}
