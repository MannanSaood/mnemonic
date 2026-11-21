"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ANSWER, CHALLENGES, POOL_STALE, PROGRAM, canAdd, canToggle, check, evictSkipping, init, lastUse, live, revealed, runUnchecked, stats, step,
  type Action, type Diagnostic, type Guess, type Kind, type Lane, type OwnerOp, type ProgramId, type State,
} from "./model";

const CSS = `
.borrowing-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--surface); }
.borrowing-grid { border-collapse: collapse; width: 100%; min-width: 520px; font-size: .8rem; }
.borrowing-grid th, .borrowing-grid td { border-bottom: 1px solid var(--line); padding: 2px 4px; vertical-align: middle; }
.borrowing-grid th { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 600; text-align: left; background: var(--bg); }
.borrowing-ln { font-family: var(--f-code); color: var(--ink-2); text-align: right; width: 2em; }
.borrowing-code { font-family: var(--f-code); white-space: pre; font-size: .76rem; }
tr.err .borrowing-code, tr.err .borrowing-ln { color: var(--pain); font-weight: 700; }
tr.err { background: var(--pain-bg); }
.borrowing-op { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; padding: 1px 4px; border: 1px solid var(--line); color: var(--ink-2); white-space: nowrap; }
.borrowing-op.write, .borrowing-op.move { border-color: var(--ink); color: var(--ink); font-weight: 700; }
.borrowing-cell { width: 4.6em; text-align: center; padding: 0 !important; }
.borrowing-cell > * { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 1.9em; font-family: var(--f-code); font-size: .7rem; border: 0; background: transparent; color: var(--ink-2); cursor: pointer; padding: 0; }
.borrowing-cell > div { cursor: default; }
.borrowing-cell .span { background: var(--hl); color: var(--accent-ink, var(--ink)); }
.borrowing-cell .span.mut { background: var(--accent); color: var(--bg); }
.borrowing-cell .start { font-weight: 700; }
.borrowing-cell .use::before { content: "●"; margin-right: 3px; }
.borrowing-cell .clash { outline: 2px solid var(--pain); outline-offset: -2px; }
.borrowing-cell button.ghost { opacity: .45; }
.borrowing-cell button.ghost:hover, .borrowing-cell button.ghost:focus-visible { opacity: 1; }
.borrowing-add { display: flex; gap: 2px; }
.borrowing-add .pg-btn { font-family: var(--f-code); font-size: .66rem; padding: 1px 5px; }
.borrowing-lanehead { display: grid; gap: 2px; justify-items: center; }
.borrowing-lanehead .pg-btn { font-family: var(--f-code); font-size: .62rem; padding: 1px 5px; }
.borrowing-diag { margin: 0; padding: 8px; border: 1px solid var(--pain); background: var(--pain-bg); font-family: var(--f-code); font-size: .74rem; white-space: pre-wrap; color: var(--ink); }
.borrowing-diag b { color: var(--pain); }
.borrowing-ok { margin: 0; padding: 8px; border: 1px solid var(--good); background: var(--good-bg); color: var(--good); font-family: var(--f-code); font-size: .8rem; font-weight: 600; }
.borrowing-run { border: 1px dashed var(--pain); background: var(--bg); padding: 8px; display: grid; gap: 6px; }
.borrowing-run.calm { border-color: var(--good); }
.borrowing-run p { margin: 0; font-size: .86rem; }
.borrowing-mem { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-family: var(--f-code); font-size: .7rem; }
.borrowing-buf { display: flex; gap: 2px; align-items: center; }
.borrowing-buf span { border: 1px solid var(--line); padding: 2px 5px; background: var(--surface); }
.borrowing-buf.freed span { border-style: dashed; color: var(--pain); background: var(--pain-bg); }
.borrowing-buf span.stale { color: var(--pain); font-weight: 700; }
.borrowing-buf span.gone { text-decoration: line-through; opacity: .5; }
.borrowing-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.borrowing-goals li { font-size: .9rem; padding-left: 1.6em; position: relative; }
.borrowing-goals li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.borrowing-goals li.met::before { content: "✓"; color: var(--good); font-weight: 700; }
.borrowing-fresh { animation: pg-hop .3s var(--ease) both; }
@media (prefers-reduced-motion: reduce) { .borrowing-fresh { animation: none; } }
`;

const OP_LABEL: Record<OwnerOp, string> = { none: "", create: "owns", read: "reads", write: "needs &mut", move: "moves" };
const sym = (k: Kind) => (k === "mut" ? "&mut" : "&");

function Cell({ st, lane, row, clash, dispatch }: { st: State; lane: Lane; row: number; clash: boolean; dispatch: (a: Action) => void }) {
  const inSpan = live(lane, row);
  const cls = (extra: string) => [inSpan ? "span" : "", inSpan && lane.kind === "mut" ? "mut" : "", clash ? "clash" : "", extra].filter(Boolean).join(" ");
  if (row === lane.start) return <div className={cls("start")} title={`${lane.name} is created here as ${sym(lane.kind)}`}>{sym(lane.kind)} {lane.name}</div>;
  const isUse = lane.uses.includes(row);
  if (!canToggle(st, lane.id, row)) {
    return <div className={cls(isUse ? "use" : "")}>{isUse ? "use" : inSpan ? "│" : ""}</div>;
  }
  return (
    <button className={cls(isUse ? "use" : inSpan ? "" : "ghost")} onClick={() => dispatch({ type: "toggleUse", lane: lane.id, row })}
      aria-pressed={isUse} aria-label={`${isUse ? "Remove" : "Add"} a use of ${lane.name} on line ${row}`}>
      {isUse ? "use" : inSpan ? "│" : "+"}
    </button>
  );
}

function Timeline({ st, diags, dispatch }: { st: State; diags: Diagnostic[]; dispatch: (a: Action) => void }) {
  const p = PROGRAM[st.program];
  const errRows = new Set(diags.map((d) => d.row));
  const clash = (laneId: string, row: number) => diags.some((d) => d.row === row && d.lanes.includes(laneId));
  const anyAdd = st.lanes.length < 3;
  return (
    <div className="borrowing-wrap">
      <table className="borrowing-grid" aria-label={`Timeline of ${p.title}`}>
        <thead>
          <tr>
            <th>#</th><th>code</th><th>{p.owner}</th>
            {st.lanes.map((l) => (
              <th key={l.id} className="borrowing-cell">
                <div className="borrowing-lanehead">
                  <span>{l.name}</span>
                  {!l.fixed && (
                    <span style={{ display: "flex", gap: 2 }}>
                      <PgButton onClick={() => dispatch({ type: "flip", lane: l.id })} title={`Make ${l.name} ${l.kind === "mut" ? "shared (&)" : "mutable (&mut)"}`}>{l.kind === "mut" ? "→ &" : "→ &mut"}</PgButton>
                      <PgButton onClick={() => dispatch({ type: "removeLane", lane: l.id })} title={`Delete the borrow ${l.name}`}>×</PgButton>
                    </span>
                  )}
                  {l.fixed && <span title="The loop decides when the iterator is used">loop</span>}
                </div>
              </th>
            ))}
            {anyAdd && <th>new borrow</th>}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((row, i) => {
            const n = i + 1;
            return (
              <tr key={n} className={errRows.has(n) ? "err" : ""}>
                <td className="borrowing-ln">{n}</td>
                <td className="borrowing-code">{row.code}</td>
                <td>{row.op !== "none" && <span className={`borrowing-op ${row.op}`}>{OP_LABEL[row.op]}</span>}</td>
                {st.lanes.map((l) => (
                  <td key={l.id} className="borrowing-cell"><Cell st={st} lane={l} row={n} clash={clash(l.id, n)} dispatch={dispatch} /></td>
                ))}
                {anyAdd && (
                  <td>
                    {canAdd(st, n) && (
                      <span className="borrowing-add">
                        <PgButton onClick={() => dispatch({ type: "addLane", row: n, kind: "shared" })} title={`Borrow ${p.owner} with & on line ${n}`}>+&amp;</PgButton>
                        <PgButton onClick={() => dispatch({ type: "addLane", row: n, kind: "mut" })} title={`Borrow ${p.owner} with &mut on line ${n}`}>+&amp;mut</PgButton>
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Diagnostics({ diags, st, reduced }: { diags: Diagnostic[]; st: State; reduced: boolean }) {
  const p = PROGRAM[st.program];
  if (diags.length === 0) {
    return <p className={"borrowing-ok" + (reduced ? "" : " borrowing-fresh")} role="status">Compiles. No line has a mutable borrow alive alongside any other use of {p.owner}.</p>;
  }
  return (
    <pre className="borrowing-diag" role="status" aria-live="polite">
      {diags.map((d, i) => (
        <span key={i}>
          <b>error[{d.code}]: {d.message}</b>{"\n"}
          {[...d.notes].sort((a, b) => a.row - b.row).map((nt) => `  ${String(nt.row).padStart(2)} | ${p.rows[nt.row - 1]?.code.trim() ?? ""}\n     | ^ ${nt.text}\n`).join("")}
          {i < diags.length - 1 ? "\n" : ""}
        </span>
      ))}
    </pre>
  );
}

function Runtime({ st }: { st: State }) {
  const p = PROGRAM[st.program];
  const f = runUnchecked(p, st.lanes);
  const bad = f.some((x) => x.kind !== "ok");
  const res = evictSkipping(POOL_STALE);
  return (
    <div className={"borrowing-run" + (bad ? "" : " calm")} aria-live="polite">
      <span className="label">Without the borrow checker</span>
      {p.runtime === "realloc" && (
        <div className="borrowing-mem" aria-label="The Vec's buffer before and after push">
          <span>before push:</span>
          <span className="borrowing-buf freed">{["c1", "c2", "c3", "c4"].map((c) => <span key={c}>{c}</span>)}</span>
          <span>freed · after push:</span>
          <span className="borrowing-buf">{["c1", "c2", "c3", "c4", "c5"].map((c) => <span key={c}>{c}</span>)}</span>
          <span>(capacity 8)</span>
        </div>
      )}
      {p.runtime === "skip" && (
        <div className="borrowing-mem" aria-label="The pool before and after the skipping sweep">
          <span>pool:</span>
          <span className="borrowing-buf">{POOL_STALE.map((s, i) => <span key={i} className={(s ? "stale " : "") + (res.kept.includes(i + 1) ? "" : "gone")}>c{i + 1}{s ? "·stale" : ""}</span>)}</span>
        </div>
      )}
      {f.map((x, i) => <p key={i}>{x.row > 0 ? <b>Line {x.row}: </b> : null}{x.text}</p>)}
    </div>
  );
}

function Result({ st }: { st: State }) {
  const m = stats(st);
  if (m.tried < 3) return null;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your numbers</span>
      <p>
        You tried {m.tried} borrow layouts. The checker rejected {m.rejected} and accepted {m.accepted}. Run without
        the checker, {m.harmful} of the rejected ones would have read freed memory, skipped a stale connection, or let
        two live references see each other&apos;s writes.
      </p>
      <p className="pg-takeaway">
        Every rejection had the same shape: a mutable borrow, or a change to the owner, while another borrow was still
        going to be used. Every fix either ended a borrow earlier by moving or deleting its last use, or did the whole
        change inside one exclusive call such as retain.
      </p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "yes", label: "Yes: push does not touch conns[0]" },
  { value: "cap", label: "Only if the Vec has spare capacity" },
  { value: "no", label: "No: push needs conns to itself" },
];

const PROGRAM_OPTIONS: { value: ProgramId; label: string }[] = [
  { value: "grow", label: "Grow the pool" },
  { value: "evict", label: "Evict while iterating" },
  { value: "retain", label: "Evict with retain" },
];

export default function Borrowing() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const p = PROGRAM[st.program];
  const diags = check(p, st.lanes);
  return (
    <PgFrame title="A borrow checker you can drive" onReset={() => dispatch({ type: "reset" })}
      toolbar={<PgButton onClick={() => dispatch({ type: "unchecked", on: !st.unchecked })} title="Show what this layout would do at runtime if nothing checked it">{st.unchecked ? "Hide the unchecked run" : "Run without the checker"}</PgButton>}>
      <style>{CSS}</style>
      <p className="pg-rule">
        Each column is a reference into <code>{p.owner}</code>. A borrow is shaded from where it is created to its
        last use; <b>mutable borrows are dark</b>. Click a cell to add or remove a use, flip a borrow between &amp; and
        &amp;mut, or add a new one. The checker runs on every change.
      </p>

      <PgPredict<Guess>
        question="In Grow the pool, oldest = &conns[0] is still used on line 7, after conns.push on line 4. Does the borrow checker accept it?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed(st)}
        answer={ANSWER}
        explain="push takes &mut conns, and oldest's shared borrow is alive from line 2 to line 7, so line 4 is E0502. The checker does not look at the capacity. That is the point: here the Vec is full, the push moves every connection to a new buffer, and oldest would be left pointing at freed memory. Delete the use on line 7 and watch the error go."
      />

      <div className="pg-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="label">Program</span>
        <PgChoice<ProgramId> label="Program" value={st.program} options={PROGRAM_OPTIONS} onChange={(v) => dispatch({ type: "program", program: v })} />
      </div>

      <Timeline st={st} diags={diags} dispatch={dispatch} />
      <Diagnostics diags={diags} st={st} reduced={reduced} />
      {st.unchecked && <Runtime st={st} />}

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Challenges</span>
          <ul className="borrowing-goals" aria-label="Challenges">
            {CHALLENGES.map((c) => <li key={c.id} className={st.done.includes(c.id) ? "met" : ""}>{c.text}</li>)}
          </ul>
        </div>
        <div className="pg-card">
          <span className="label">This layout</span>
          <dl className="pg-stats">
            <div className={diags.length ? "bad" : ""}><dt>Errors</dt><dd>{diags.length}</dd></div>
            <div><dt>Borrows</dt><dd>{st.lanes.length}</dd></div>
            <div><dt>Longest</dt><dd>{st.lanes.length ? Math.max(...st.lanes.map((l) => lastUse(l) - l.start + 1)) : 0} lines</dd></div>
            <div><dt>Layouts tried</dt><dd>{stats(st).tried}</dd></div>
          </dl>
        </div>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Aquascope's permission view (Brown University)", href: "https://cel.cs.brown.edu/aquascope/" },
        { title: "RustViz borrow timelines", href: "https://arxiv.org/abs/2011.09012" },
        { title: "The Rust Book, chapter 4.2", href: "https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html" },
      ]} />
    </PgFrame>
  );
}
