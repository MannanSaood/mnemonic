"use client";
import { useState } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BP_MAX, BP_MIN, GOALS, HOST, PREFIX_BP, PRESETS, builtIds, evaluate, explain, frames, height, init, parse, printTop, rowOf, step,
  type Expr, type Row,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const ROW_LABEL: Record<Row["key"], string> = { or: "or", and: "and", cmp: "== != < <= > >=", add: "+ -", mul: "* /" };

function TreeNode({ e, built, fresh }: { e: Expr; built: Set<number>; fresh: number | null }) {
  const on = built.has(e.id);
  const cls = "pratt-node" + (on ? "" : " ghost") + (e.id === fresh ? " fresh" : "");
  if (e.kind === "leaf") return <li className={cls}><span className="pratt-box leaf"><code>{e.tok.text}</code></span></li>;
  const kids = e.kind === "unary" ? [e.x] : [e.left, e.right];
  return (
    <li className={cls}>
      <span className="pratt-box op"><b>{e.op}</b></span>
      <ul>{kids.map((k) => <TreeNode key={k.id} e={k} built={built} fresh={fresh} />)}</ul>
    </li>
  );
}

type Guess = "or" | "and";

export default function PrattPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const r = parse(st.src, st.table);
  const total = r.events.length;
  const cur = st.shown > 0 ? r.events[st.shown - 1] : null;
  const stack = frames(r.events, st.shown);
  const built = builtIds(r.events, st.shown);
  const fresh = cur && (cur.type === "build" || cur.type === "operand") && !reduced ? cur.node.id : null;
  const at = cur ? cur.at : 0;
  const result = r.tree ? evaluate(r.tree) : null;
  const done = st.shown === total;
  const revealed = (st.src === PRESETS[0].src && done) || st.edits > 0;
  const seenTrees = st.trees[st.src]?.length ?? 0;
  const comparisonsSoFar = r.events.slice(0, st.shown).filter((e) => e.type === "decide" && e.bp !== null).length;

  return (
    <PgFrame title="Parse a rule with a table of binding powers" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question={'In cpu > 0.95 or mem > 0.9 and env == "prod", or has power 1 and and has power 2. Which operator gets mem > 0.9 as its operand?'}
        options={[{ value: "or", label: "or" }, { value: "and", label: "and" }]}
        value={guess} onChange={setGuess} revealed={revealed} answer="and"
        explain={<>mem &gt; 0.9 sits between or and and. The parser is inside or&apos;s right side, parseExpr(1), when it meets and. Power 2 is above 1, so and binds and takes mem &gt; 0.9 as its left. The higher power grabs the operand in the middle. That is all precedence is.</>}
      />
      {!revealed && <p className="pratt-small muted">Step the Mixed and/or rule to the end, or change any number in the table, to check your answer.</p>}

      <div className="pg-card">
        <span className="label">The rule</span>
        <div className="pg-actions">
          {PRESETS.map((p, i) => (
            <button key={p.label} className={"pg-btn" + (st.src === p.src ? " primary" : "")} aria-pressed={st.src === p.src} onClick={() => dispatch({ type: "preset", index: i })}>{p.label}</button>
          ))}
        </div>
        <input className="pratt-input" spellCheck={false} aria-label="Alert rule" value={st.src} onChange={(e) => dispatch({ type: "edit", src: e.target.value })} />
        <div className="pratt-tokens" aria-label="Tokens with binding powers">
          {r.tokens.filter((t) => t.kind !== "eof").map((t, i) => {
            const row = rowOf(st.table, t);
            const pre = (t.kind === "op" || t.kind === "keyword") && t.text in PREFIX_BP && !row;
            return (
              <span key={i} className={"pratt-tok" + (row ? " op" : "") + (i === at && !done ? " here" : "") + (t.kind === "error" ? " bad" : "")}>
                <code>{t.text}</code>
                <i>{row ? `bp ${row.bp}` : pre ? `pre ${PREFIX_BP[t.text]}` : " "}</i>
              </span>
            );
          })}
        </div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Binding powers · the whole grammar of operators</span>
          <table className="pratt-table">
            <thead><tr><th>operators</th><th>power</th><th>assoc</th></tr></thead>
            <tbody>
              {st.table.map((row) => (
                <tr key={row.key}>
                  <td><code>{ROW_LABEL[row.key]}</code></td>
                  <td>
                    <span className="pratt-bp">
                      <button className="pg-btn" aria-label={`Lower the power of ${ROW_LABEL[row.key]}`} disabled={row.bp <= BP_MIN} onClick={() => dispatch({ type: "bp", key: row.key, delta: -1 })}>−</button>
                      <b>{row.bp}</b>
                      <button className="pg-btn" aria-label={`Raise the power of ${ROW_LABEL[row.key]}`} disabled={row.bp >= BP_MAX} onClick={() => dispatch({ type: "bp", key: row.key, delta: 1 })}>+</button>
                      <span className="pratt-bar" aria-hidden="true"><i style={{ width: `${(row.bp / BP_MAX) * 100}%` }} /></span>
                    </span>
                  </td>
                  <td><button className="pg-btn pratt-assoc" aria-pressed={row.assoc === "right"} onClick={() => dispatch({ type: "assoc", key: row.key })} title="Switch associativity">{row.assoc}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pratt-small muted">Prefix: not parses its operand at 3, unary − at 7. The parser code never changes; only this table does.</p>
        </div>

        <div className="pg-card">
          <span className="label">parseExpr, step by step</span>
          <div className="pg-actions">
            <PgButton primary onClick={() => dispatch({ type: "step" })} disabled={done}>{st.shown === 0 ? "Start parsing" : "Step"}</PgButton>
            <PgButton onClick={() => dispatch({ type: "run" })} disabled={done}>Run to end</PgButton>
            <PgButton onClick={() => dispatch({ type: "back" })} disabled={st.shown === 0}>Back</PgButton>
          </div>
          <div className="pratt-stack" aria-label="Open calls">
            {stack.length === 0 && <span className="pratt-small muted">{done ? "All calls have returned." : "No calls yet."}</span>}
            {stack.map((f, i) => (
              <div key={i} className={"pratt-frame" + (i === stack.length - 1 ? " top" : "")} style={{ marginLeft: `${f.depth * 10}px` }}>
                parseExpr(<b>{f.minBp}</b>)
              </div>
            ))}
          </div>
          <p className={"pratt-why" + (cur?.type === "decide" ? (cur.bind ? " bind" : " stop") : "") + (cur?.type === "error" ? " bad" : "")} aria-live="polite">
            {cur ? explain(cur) : "Press Start parsing. The first call is parseExpr(0): every operator is strong enough to bind at the top."}
          </p>
        </div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">The tree · dashed nodes are not built yet</span>
          {r.tree ? <ul className="pratt-tree"><TreeNode e={r.tree} built={built} fresh={fresh} /></ul> : <p className="pratt-small pratt-bad">{r.error}</p>}
        </div>
        <div className="pg-card">
          <span className="label">What the alert does on a staging host</span>
          <code className="pratt-code">{Object.entries(HOST).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  ")}</code>
          {r.tree && <code className="pratt-code">{printTop(r.tree)}</code>}
          <p className={"pratt-verdict" + (result?.error || r.error ? " bad" : result?.value === true ? " page" : "")}>
            {r.error ? "Rule rejected at save time." : result?.error ? `Parses, but cannot run: ${result.error}.` : typeof result?.value === "boolean" ? (result.value ? "Fires: on-call gets paged." : "Silent: no page.") : `Value: ${result?.value}`}
          </p>
          <dl className="pg-stats">
            <div><dt>Steps</dt><dd>{st.shown} / {total}</dd></div>
            <div><dt>Power checks</dt><dd>{comparisonsSoFar}</dd></div>
            <div><dt>Deepest call</dt><dd>{r.maxDepth}</dd></div>
            <div><dt>Tree height</dt><dd>{r.tree ? height(r.tree) : "–"}</dd></div>
          </dl>
        </div>
      </div>

      <div className="pg-req">
        <span className="label">Try these</span>
        <ul className="pratt-goals">
          {GOALS.map((g) => <li key={g.id} className={st.goals[g.id] ? "done" : ""}>{st.goals[g.id] ? "✓ " : "○ "}{g.text}</li>)}
        </ul>
      </div>

      {st.edits > 0 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your table did</span>
          <p>
            You changed the table {n(st.edits, "time")}. The same {n(r.tokens.length - 1, "token")} have parsed into {n(seenTrees, "different tree")} so far, and the alert&apos;s result flipped {n(st.flips, "time")}. Not one line of parser code changed.
          </p>
          <p className="pg-takeaway">
            A Pratt parser is one loop: read an operand, then keep taking operators whose power is above the caller&apos;s minimum. The higher power grabs the operand between two operators, and passing the same power to the right side makes equal operators group to the left.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Vaughan Pratt, Top Down Operator Precedence (1973)", href: "https://tdop.github.io/" },
        { title: "matklad, Simple but Powerful Pratt Parsing", href: "https://matklad.github.io/2020/04/13/simple-but-powerful-pratt-parsing.html" },
        { title: "How Desmos uses Pratt Parsers", href: "https://engineering.desmos.com/articles/pratt-parser/" },
      ]} />

      <style>{`
        .pratt-small { font-size: .88rem; margin: 0; }
        .pratt-small.muted { color: var(--ink-2); }
        .pratt-bad { color: var(--pain); }
        .pratt-input { width: 100%; font-family: var(--f-code); font-size: .85rem; padding: 6px 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 0; }
        .pratt-tokens { display: flex; flex-wrap: wrap; gap: 4px; }
        .pratt-tok { display: inline-grid; justify-items: center; border: 1px solid var(--line); background: var(--surface); padding: 2px 6px; transition: border-color .15s, background-color .15s; }
        .pratt-tok code { font-size: .8rem; background: none; }
        .pratt-tok i { font-style: normal; font-family: var(--f-code); font-size: .56rem; color: var(--ink-2); text-transform: uppercase; }
        .pratt-tok.op { border-color: var(--accent); }
        .pratt-tok.op i { color: var(--accent); font-weight: 700; }
        .pratt-tok.here { background: var(--hl); box-shadow: inset 0 0 0 1px var(--accent); }
        .pratt-tok.bad { border-color: var(--pain); background: var(--pain-bg); }
        .pratt-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
        .pratt-table th { font-family: var(--f-code); font-size: .58rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); text-align: left; padding: 2px 4px; }
        .pratt-table td { border-top: 1px solid var(--line); padding: 4px; vertical-align: middle; }
        .pratt-table td code { font-size: .74rem; white-space: normal; }
        .pratt-bp { display: inline-flex; align-items: center; gap: 4px; }
        .pratt-bp .pg-btn, .pratt-assoc { padding: 0 7px; font-size: .8rem; min-width: 26px; }
        .pratt-bp b { font-family: var(--f-code); min-width: 1.2em; text-align: center; }
        .pratt-bar { display: inline-block; width: 46px; height: 6px; border: 1px solid var(--line); background: var(--surface); }
        .pratt-bar i { display: block; height: 100%; background: var(--accent); transition: width .2s var(--ease); }
        .pratt-stack { display: grid; gap: 3px; min-height: 30px; }
        .pratt-frame { font-family: var(--f-code); font-size: .78rem; border: 1px solid var(--line); background: var(--surface); padding: 2px 8px; justify-self: start; }
        .pratt-frame.top { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
        .pratt-why { margin: 0; font-size: .9rem; border-left: 3px solid var(--line); padding: 4px 10px; background: var(--surface); }
        .pratt-why.bind { border-left-color: var(--good); }
        .pratt-why.stop { border-left-color: var(--accent); }
        .pratt-why.bad { border-left-color: var(--pain); color: var(--pain); }
        .pratt-tree, .pratt-tree ul { list-style: none; margin: 0; padding: 0; }
        .pratt-tree ul { padding-left: 14px; border-left: 1px dashed var(--line); margin-left: 8px; }
        .pratt-node { padding-top: 3px; transition: opacity .2s; }
        .pratt-box { display: inline-block; border: 1px solid var(--line); background: var(--surface); padding: 1px 8px; font-family: var(--f-code); font-size: .78rem; }
        .pratt-box.op { border-color: var(--accent); color: var(--accent); }
        .pratt-box code { background: none; font-size: .78rem; }
        .pratt-node.ghost > .pratt-box { border-style: dashed; opacity: .4; }
        .pratt-node.fresh > .pratt-box { background: var(--good-bg); border-color: var(--good); }
        .pratt-code { display: block; white-space: pre-wrap; word-break: break-word; font-size: .72rem; padding: 4px 8px; }
        .pratt-verdict { margin: 0; font-weight: 600; }
        .pratt-verdict.page { color: var(--good); }
        .pratt-verdict.bad { color: var(--pain); }
        .pratt-goals { list-style: none !important; padding-left: 0 !important; }
        .pratt-goals li.done { color: var(--good); }
        @media (prefers-reduced-motion: reduce) { .pratt-tok, .pratt-node, .pratt-bar i { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
