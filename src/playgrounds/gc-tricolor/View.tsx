"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  H, MUTATION, ROOTS, W, greys, init, reachable, step,
  type Guess, type Mutation, type Obj, type RunResult, type State,
} from "./model";

const NW = 112, NH = 46;

const CSS = `
.gt-graph { position: relative; width: 100%; aspect-ratio: ${W} / ${H}; border: 1px solid var(--line); background-color: var(--bg);
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 20px 20px; }
.gt-graph svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.gt-edge { stroke: var(--ink-2); stroke-width: 1.4; fill: none; }
.gt-edge.fresh { stroke: var(--accent); stroke-width: 2.4; }
.gt-edge.dead { stroke-dasharray: 3 3; opacity: .5; }
.gt-node { position: absolute; transform: translate(-50%, -50%); width: ${(NW / W) * 100}%; height: ${(NH / H) * 100}%; display: grid; align-content: center; gap: 0;
  border: 1.5px solid var(--ink); background: var(--surface); color: var(--ink); font-family: var(--f-code); padding: 1px 2px; cursor: pointer; text-align: center;
  transition: background-color .25s var(--ease), color .25s var(--ease); line-height: 1.15; }
.gt-node b { font-size: clamp(.5rem, 1.6vw, .7rem); font-weight: 600; letter-spacing: .03em; }
.gt-node span { font-size: clamp(.45rem, 1.3vw, .58rem); text-transform: uppercase; letter-spacing: .05em; opacity: .8; }
.gt-node.grey { background: var(--surface-2); border-width: 3px; border-color: var(--ink-2); }
.gt-node.black { background: var(--ink); color: var(--bg); }
.gt-node.freed { background: transparent; border-style: dashed; border-color: var(--ink-2); color: var(--ink-2); text-decoration: line-through; }
.gt-node.dangling { background: var(--pain-bg); border: 3px solid var(--pain); color: var(--pain); text-decoration: line-through; }
.gt-node.flash { outline: 3px solid var(--accent); outline-offset: 2px; }
.gt-node:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.gt-root { position: absolute; transform: translate(-50%, -50%); width: ${(NW / W) * 100}%; height: ${(NH / H) * 100}%; display: grid; align-content: center; text-align: center;
  border: 1.5px dashed var(--accent); color: var(--accent); background: var(--surface); font-family: var(--f-code); line-height: 1.15; }
.gt-root b { font-size: clamp(.5rem, 1.6vw, .7rem); text-transform: uppercase; letter-spacing: .08em; }
.gt-root span { font-size: clamp(.45rem, 1.3vw, .58rem); }
.gt-phases { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; }
.gt-phases span { font-family: var(--f-code); font-size: .58rem; letter-spacing: .05em; text-transform: uppercase; border: 1px solid var(--line); padding: 3px 4px; color: var(--ink-2); }
.gt-phases span.on { border-color: var(--accent); color: var(--accent); font-weight: 700; background: var(--hl); }
.gt-controls { display: grid; gap: 6px; }
.gt-controls > div { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.gt-sub { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.gt-mut code { font-size: .7rem; }
.gt-key { display: flex; flex-wrap: wrap; gap: 10px; font-size: .78rem; color: var(--ink-2); }
.gt-key i { display: inline-block; width: 12px; height: 10px; margin-right: 4px; vertical-align: middle; border: 1.5px solid var(--ink); }
.gt-events { margin: 0; padding-left: 1.1em; font-size: .85rem; color: var(--ink-2); display: grid; gap: 2px; max-height: 160px; overflow: auto; }
.gt-runs { width: 100%; border-collapse: collapse; font-size: .82rem; }
.gt-runs th, .gt-runs td { border: 1px solid var(--line); padding: 3px 5px; text-align: right; font-variant-numeric: tabular-nums; }
.gt-runs th:first-child, .gt-runs td:first-child { text-align: left; }
.gt-runs th { font-family: var(--f-code); font-size: .56rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.gt-runs td.bad { color: var(--pain); font-weight: 700; }
.gt-challenge { border-left: 3px solid var(--accent); padding: 4px 8px; font-size: .88rem; margin: 0; }
@media (prefers-reduced-motion: reduce) { .gt-node { transition: none; } }
`;

const pos = (st: State, id: string) => ROOTS.find((r) => r.id === id) ?? st.objs[id];

/** Shorten a line so it ends at the border of the target box. */
function clip(x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const hw = NW / 2 + 3, hh = NH / 2 + 3;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { sx: x1 + dx * t, sy: y1 + dy * t, ex: x2 - dx * t, ey: y2 - dy * t };
}

function Graph({ st, dispatch }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  const live = reachable(st);
  const isFresh = (f: string, t: string) => st.fresh.some(([a, b]) => a === f && b === t);
  const hint = (o: Obj) => o.freed ? (live.has(o.id) ? "freed while still in use" : "freed") : o.color === "grey" ? "grey: press to scan" : o.color;
  return (
    <div className="gt-graph">
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <defs>
          <marker id="gt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-2)" />
          </marker>
          <marker id="gt-arrow-new" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
          </marker>
        </defs>
        {st.edges.map(([f, t]) => {
          const a = pos(st, f), b = pos(st, t);
          if (!a || !b) return null;
          const { sx, sy, ex, ey } = clip(a.x, a.y, b.x, b.y);
          const fresh = isFresh(f, t);
          const dead = !live.has(t);
          return <line key={f + t} x1={sx} y1={sy} x2={ex} y2={ey} className={"gt-edge" + (fresh ? " fresh" : "") + (dead ? " dead" : "")} markerEnd={`url(#${fresh ? "gt-arrow-new" : "gt-arrow"})`} />;
        })}
      </svg>
      {ROOTS.map((r) => (
        <div key={r.id} className="gt-root" style={{ left: `${(r.x / W) * 100}%`, top: `${(r.y / H) * 100}%` }}>
          <b>root: {r.label}</b><span>{r.sub}</span>
        </div>
      ))}
      {Object.values(st.objs).map((o) => {
        const cls = o.freed ? (live.has(o.id) ? "dangling" : "freed") : o.color;
        return (
          <button key={o.id} className={`gt-node ${cls}` + (st.flash.includes(o.id) ? " flash" : "")}
            style={{ left: `${(o.x / W) * 100}%`, top: `${(o.y / H) * 100}%` }}
            onClick={() => dispatch({ type: "scan", id: o.id })}
            aria-label={`${o.label}${o.sub ? ", " + o.sub : ""}: ${hint(o)}`}
            aria-disabled={!(st.phase === "mark" && o.color === "grey")}>
            <b>{o.label}</b>
            <span>{o.freed ? (live.has(o.id) ? "use after free" : "freed") : o.sub || o.color}</span>
          </button>
        );
      })}
    </div>
  );
}

const PHASES: { key: State["phase"][]; text: string }[] = [
  { key: ["idle"], text: "Not running" },
  { key: ["mark"], text: "Mark (you), program runs" },
  { key: ["marked"], text: "STW: mark termination" },
  { key: ["swept"], text: "Sweep: free white" },
];

function Stats({ st }: { st: State }) {
  const live = reachable(st);
  const freed = Object.values(st.objs).filter((o) => o.freed);
  const bad = freed.filter((o) => live.has(o.id)).length;
  return (
    <dl className="pg-stats">
      <div><dt>Grey left</dt><dd>{greys(st).length}</dd></div>
      <div><dt>Objects scanned</dt><dd>{st.scanned}</dd></div>
      <div><dt>Pointers followed</dt><dd>{st.followed}</dd></div>
      <div><dt>Barrier shades</dt><dd>{st.shades}</dd></div>
      <div><dt>Freed</dt><dd>{freed.length}</dd></div>
      <div className={bad ? "bad" : ""}><dt>Live objects freed</dt><dd>{bad}</dd></div>
      <div><dt>Barrier</dt><dd>{st.barrier ? "on" : "off"}</dd></div>
      <div><dt>Phase</dt><dd>{st.phase}</dd></div>
    </dl>
  );
}

function Runs({ runs }: { runs: RunResult[] }) {
  if (!runs.length) return null;
  return (
    <table className="gt-runs">
      <caption className="label" style={{ textAlign: "left" }}>Your cycles</caption>
      <thead><tr><th>Cycle</th><th>Live freed</th><th>Garbage freed</th><th>Floating</th><th>Shades</th></tr></thead>
      <tbody>
        {runs.map((r, i) => (
          <tr key={i}>
            <td>Barrier {r.barrier ? "on" : "off"}{r.merged ? ", cart moved" : ""}</td>
            <td className={r.freedLive.length ? "bad" : ""}>{r.freedLive.length}</td>
            <td>{r.freedGarbage}</td>
            <td>{r.floating}</td>
            <td>{r.shades}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ runs }: { runs: RunResult[] }) {
  const broken = [...runs].reverse().find((r) => !r.barrier && r.freedLive.length);
  const saved = [...runs].reverse().find((r) => r.barrier && r.merged);
  if (!broken || !saved) {
    return <p className="muted" aria-live="polite">{broken ? "Now turn the barrier on and play the same moves." : runs.length ? "Try the challenge: barrier off, and make the GC free the cart while Session u42 still points to it." : ""}</p>;
  }
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>Without the barrier, your cycle freed <b>{broken.freedLive.join(" and ")}</b> while Session u42 still pointed to them. With the barrier on, the same login cost <b>{saved.shades}</b> extra shade{saved.shades === 1 ? "" : "s"}, freed {saved.freedLive.length} live objects, and left {saved.floating} dead object{saved.floating === 1 ? "" : "s"} for the next cycle.</p>
      <p className="pg-takeaway">The collector runs while your code moves pointers. If a pointer to a white object moves into a black object and the grey path to it is cut, nothing will ever scan it. The write barrier shades the object on that store, which costs a few instructions per pointer write and sometimes keeps garbage one cycle longer.</p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "survives", label: "It survives: it is still reachable" },
  { value: "freed", label: "It is freed while still in use" },
  { value: "rescan", label: "The GC notices and rescans u42" },
];

export default function GcTricolor() {
  const { state: st, dispatch } = useModel(step, init);
  const revealed = st.runs.some((r) => !r.barrier && r.merged);
  const idle = st.phase === "idle" || st.phase === "swept";
  const canMutate = st.phase === "idle" || st.phase === "mark";

  return (
    <PgFrame title="Mark it while it moves" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        You are the garbage collector. A login handler is running and keeps changing pointers. <b>Start a cycle, press grey objects to scan them, and
        let the program move a pointer while you mark.</b> At the end, sweep frees everything still white.
      </p>

      <PgPredict<Guess>
        question="The barrier is off. You have scanned sessions and Session u42 (both black); Session g7 is still grey. Now the handler runs u42.Cart = g7.Cart; g7.Cart = nil. What happens to Cart g7 at sweep?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed}
        answer="freed"
        explain="If Session u42 was black when the cart moved, the collector never looks at it again, and Session g7 no longer leads to the cart. The cart stays white and is freed while u42 points to it. The write barrier exists to stop exactly this: it shades the cart grey on the pointer store."
      />

      <p className="gt-challenge"><b>Challenge.</b> Barrier off: make the GC free the cart while Session u42 still points to it. Then play the same moves with the barrier on.</p>

      <div className="gt-controls">
        <div><span className="gt-sub">Write barrier</span>
          <PgChoice label="Write barrier" value={st.barrier ? "on" : "off"} options={[{ value: "on", label: "on" }, { value: "off", label: "off (what if)" }]}
            onChange={(v) => dispatch({ type: "barrier", on: v === "on" })} disabledOptions={idle ? [] : [st.barrier ? "off" : "on"]} />
          <span className="gt-sub">{idle ? "" : "locked during a cycle"}</span>
        </div>
        <div><span className="gt-sub">Collector</span>
          <PgButton primary onClick={() => dispatch({ type: "start" })} disabled={st.phase !== "idle"}>Start a cycle</PgButton>
          <PgButton onClick={() => dispatch({ type: "scanNext" })} disabled={st.phase !== "mark"}>Scan next grey</PgButton>
          <PgButton onClick={() => dispatch({ type: "finish" })} disabled={st.phase !== "mark"}>Finish marking</PgButton>
          <PgButton primary={st.phase === "marked"} onClick={() => dispatch({ type: "sweep" })} disabled={st.phase !== "marked"}>Sweep</PgButton>
          {st.phase !== "idle" && <PgButton onClick={() => dispatch({ type: "again" })}>New heap</PgButton>}
        </div>
        <div className="gt-mut"><span className="gt-sub">Program (mutator)</span>
          {(["merge", "add", "drop"] as Mutation[]).map((m) => (
            <PgButton key={m} onClick={() => dispatch({ type: "mutate", m })} disabled={!canMutate || st.done[m]} title={MUTATION[m].code}>{MUTATION[m].label}</PgButton>
          ))}
        </div>
      </div>

      <div className="pg-card">
        <div className="gt-phases" aria-label="GC phase">
          {PHASES.map((p) => <span key={p.text} className={p.key.includes(st.phase) ? "on" : ""}>{p.text}</span>)}
        </div>
        <Graph st={st} dispatch={dispatch} />
        <div className="gt-key">
          <span><i style={{ background: "var(--surface)" }} />white: not reached yet</span>
          <span><i style={{ background: "var(--surface-2)", borderWidth: 3, borderColor: "var(--ink-2)" }} />grey: reached, not scanned</span>
          <span><i style={{ background: "var(--ink)" }} />black: scanned</span>
          <span><i style={{ background: "var(--pain-bg)", borderColor: "var(--pain)" }} />freed while in use</span>
          <span><i style={{ borderColor: "var(--accent)" }} />new pointer</span>
        </div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <Stats st={st} />
          <ol className="gt-events" aria-live="polite">
            {st.events.slice(0, 8).map((e, i) => <li key={st.events.length - i}>{e}</li>)}
          </ol>
        </div>
        <div className="pg-card">
          <Runs runs={st.runs} />
          <Result runs={st.runs} />
          <p className="pg-note">The barrier switch is a what-if: Go always runs the barrier while it marks. Here it shades both the old and the new target of every pointer store; the real hybrid barrier shades the new one only while the storing goroutine's stack is not yet scanned.</p>
        </div>
      </div>

      <PgSources links={[
        { title: "Pusher, Golang's real-time GC in theory and practice (tri-colour animation)", href: "https://pusher.com/blog/golangs-real-time-gc-in-theory-and-practice/" },
        { title: "Rick Hudson, Getting to Go: the journey of Go's garbage collector", href: "https://go.dev/blog/ismmkeynote" },
        { title: "the comments in runtime/mbarrier.go", href: "https://github.com/golang/go/blob/master/src/runtime/mbarrier.go" },
      ]} />
    </PgFrame>
  );
}
