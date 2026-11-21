"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  TASKS, USERS, check, cost, count, evaluate, init, matches, print, sameSet, step,
  type Action, type Mark, type Node, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

/* ---------------- a fourth interpretation: the same tree as hard-coded code ---------------- */

const FIELD: Record<Lang, (a: string) => string> = {
  go: (a) => "u." + a[0].toUpperCase() + a.slice(1),
  python: (a) => "u." + a.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
  typescript: (a) => "u." + a,
  rust: (a) => "u." + a.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
};
function compile(nd: Node, lang: Lang, top = true): string {
  const f = FIELD[lang];
  const AND = lang === "python" ? " and " : " && ", OR = lang === "python" ? " or " : " || ", NOT = lang === "python" ? "not " : "!";
  switch (nd.kind) {
    case "and":
    case "or": {
      const s = nd.kids.map((k) => compile(k, lang, false)).join(nd.kind === "and" ? AND : OR);
      return top ? s : `(${s})`;
    }
    case "not": return NOT + compile(nd.kid, lang, false);
    case "in": {
      const q = nd.values.map((v) => `"${v}"`).join(", ");
      return { go: `slices.Contains([]string{${q}}, ${f(nd.attr)})`, python: `${f(nd.attr)} in {${q}}`, typescript: `[${q}].includes(${f(nd.attr)})`, rust: `[${q}].contains(&${f(nd.attr)}.as_str())` }[lang];
    }
    case "eq": return typeof nd.value === "boolean" ? (nd.value ? f(nd.attr) : NOT + f(nd.attr)) : `${f(nd.attr)} == "${nd.value}"`;
    case "gte": return `${f(nd.attr)} >= ${nd.n}`;
  }
}

/* ---------------- the tree ---------------- */

const OP: Record<Node["kind"], string> = { and: "AND", or: "OR", not: "NOT", in: "IN", eq: "=", gte: "≥" };

function leafText(nd: Node): string {
  if (nd.kind === "in") return `${nd.attr} in [${nd.values.join(", ")}]`;
  if (nd.kind === "eq") return typeof nd.value === "boolean" ? `${nd.attr} is ${nd.value}` : `${nd.attr} = ${nd.value}`;
  if (nd.kind === "gte") return `${nd.attr} ≥ ${nd.n}`;
  return "";
}

function Badge({ m }: { m: Mark | undefined }) {
  if (m === undefined) return null;
  const text = m === "skipped" ? "skipped" : m === "error" ? "error" : m ? "true" : "false";
  return <span className={`interpreter-badge ${m === "skipped" ? "skip" : m === "error" ? "err" : m ? "yes" : "no"}`}>{text}</span>;
}

function Tree({ nd, marks, dispatch, root }: { nd: Node; marks: Record<number, Mark> | null; dispatch: (a: Action) => void; root?: boolean }) {
  const m = marks?.[nd.id];
  const branch = nd.kind === "and" || nd.kind === "or";
  return (
    <li className={"interpreter-node" + (m === "skipped" ? " skipped" : "") + (m === "error" ? " err" : "")}>
      <div className="interpreter-box">
        <span className="interpreter-op">{OP[nd.kind]}</span>
        {!branch && nd.kind !== "not" && <code>{leafText(nd)}</code>}
        <Badge m={m} />
        <span className="interpreter-tools">
          {branch && <PgButton onClick={() => dispatch({ type: "flip", id: nd.id })} title="Switch between AND and OR">{nd.kind === "and" ? "→ OR" : "→ AND"}</PgButton>}
          {(nd.kind === "in" || nd.kind === "eq" || nd.kind === "gte") && <PgButton onClick={() => dispatch({ type: "cycle", id: nd.id })} title="Change the value">value</PgButton>}
          {nd.kind === "gte" && <PgButton onClick={() => dispatch({ type: "attr", id: nd.id })} title="Read another attribute">attribute</PgButton>}
          {!root && <PgButton onClick={() => dispatch({ type: "negate", id: nd.id })} title={nd.kind === "not" ? "Remove this NOT" : "Wrap in NOT"}>{nd.kind === "not" ? "unwrap" : "NOT"}</PgButton>}
        </span>
      </div>
      {branch && <ul>{nd.kids.map((k) => <Tree key={k.id} nd={k} marks={marks} dispatch={dispatch} />)}</ul>}
      {nd.kind === "not" && <ul><Tree nd={nd.kid} marks={marks} dispatch={dispatch} /></ul>}
    </li>
  );
}

/* ---------------- page ---------------- */

type Guess = "2" | "4" | "7";

export default function InterpreterPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const picked = USERS.find((u) => u.name === st.user) ?? null;
  const trace = picked ? evaluate(st.rule, picked) : null;
  const hit = matches(st.rule);
  const errors = check(st.rule);
  const c = cost(st.rule);
  const task = TASKS[st.task];
  const unsaved = print(st.rule) !== print(st.saved);
  const revealed = st.user === "Sam" || st.user === "Priya";

  return (
    <PgFrame title="A targeting rule as a tree you can edit" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question={`The rule has ${count(st.rule)} nodes. Sam is in the US. How many of them run to decide Sam's flag?`}
        options={[{ value: "2", label: "2" }, { value: "4", label: "4" }, { value: "7", label: "All 7" }]}
        value={guess} onChange={setGuess} revealed={revealed} answer="2"
        explain={<>The root AND asks its first child, the country check. It returns false, and an AND with one false child is false, so the AND returns without asking the rest. Each node only asks its own children: that recursion is the whole interpreter. Click Sam below to see it.</>}
      />

      <div className="pg-req">
        <span className="label">Task {st.task + 1} of {TASKS.length}{st.done[st.task] ? " · done" : ""}</span>
        <h3>{task.title}</h3>
        <p>{task.ask}</p>
        {st.done[st.task] && st.task < TASKS.length - 1 && <div><PgButton primary onClick={() => dispatch({ type: "nextTask" })}>Next task →</PgButton></div>}
        {st.done[st.task] && st.task === TASKS.length - 1 && <p className="pg-rule">The checker is another interpretation of the same tree. It caught the error before any request did.</p>}
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">The rule, as a tree · edit any node</span>
          <ul className="interpreter-tree"><Tree nd={st.rule} marks={trace?.marks ?? null} dispatch={dispatch} root /></ul>
          {trace && (
            <p className={"interpreter-small" + (trace.error ? " interpreter-errtext" : "")} aria-live="polite">
              {picked!.name}: {trace.error ? `evaluation failed: ${trace.error}.` : `${trace.value ? "flag on" : "flag off"}, ${n(trace.evaluated, "node")} of ${count(st.rule)} ran.`}
            </p>
          )}
        </div>
        <div className="pg-card">
          <span className="label">Customers · click one to trace</span>
          <div className="interpreter-users">
            {USERS.map((u) => {
              const r = evaluate(st.rule, u).value;
              const want = task.target?.includes(u.name);
              return (
                <button key={u.name} className={"interpreter-user" + (st.user === u.name ? " on" : "") + (r === "error" ? " err" : r ? " yes" : "") + (want ? " want" : "")}
                  aria-pressed={st.user === u.name} onClick={() => dispatch({ type: "pick", user: u.name })}>
                  <b>{u.name}</b> <span>{u.country} · {u.plan} · {u.seats}{u.optOut ? " · opted out" : ""}</span>
                  <i>{r === "error" ? "error" : r ? "on" : "off"}</i>
                </button>
              );
            })}
          </div>
          <p className="interpreter-small muted">Dashed outline: who the task wants. Filled: who the rule matches now.</p>
          <dl className="pg-stats">
            <div className={task.target && !sameSet(hit, task.target) ? "bad" : ""}><dt>Flag on for</dt><dd>{hit.length} / {USERS.length}</dd></div>
            <div><dt>Nodes run, all users</dt><dd>{c.lazy} of {c.eager}</dd></div>
            <div><dt>Rule edits</dt><dd>{st.edits}</dd></div>
            <div><dt>Deploys</dt><dd>0</dd></div>
          </dl>
        </div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Print: the same tree as text</span>
          <code className="interpreter-code">{print(st.rule)}</code>
          <span className="label">Check: the same tree, type-checked</span>
          {errors.length ? errors.map((e) => <p key={e} className="interpreter-small interpreter-errtext">{e}</p>) : <p className="interpreter-small interpreter-ok">No type errors.</p>}
          <div className="pg-actions">
            <PgButton primary onClick={() => dispatch({ type: "save" })} disabled={!unsaved && !errors.length}>Save rule</PgButton>
            {unsaved && <span className="interpreter-small muted">Unsaved changes</span>}
          </div>
          {st.message && <p className={"interpreter-small" + (st.message.startsWith("Not") ? " interpreter-errtext" : " interpreter-ok")} aria-live="polite">{st.message}</p>}
        </div>
        <div className="pg-card">
          <span className="label">The same rule, hard-coded ({lang})</span>
          <code className="interpreter-code">{compile(st.rule, lang)}</code>
          <p className="interpreter-small">Hard-coded, each of your {n(st.edits, "edit")} would be a code change, a review and {n(st.edits, "deploy")}. As a tree, it is data in the flag store.</p>
        </div>
      </div>

      {st.edits > 0 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your edits did</span>
          <p>
            You changed the rule {n(st.edits, "time")} and saved it {n(st.saves, "time")}, with no deploys. It now turns the flag on for {n(hit.length, "customer")} of {USERS.length}.
            {st.rejected > 0 && <> The checker refused {n(st.rejected, "save")} that would have thrown errors in production.</>}
          </p>
          <p className="pg-takeaway">
            Each node knows one grammar rule and asks only its children, so any combination of them evaluates correctly. The rule became data: product can change it without a deploy, and the same tree can be printed, checked and evaluated by separate interpretations.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "JsonLogic and its playground", href: "https://jsonlogic.com/" },
        { title: "Crafting Interpreters, Evaluating Expressions", href: "https://craftinginterpreters.com/evaluating-expressions.html" },
        { title: "AST Explorer", href: "https://astexplorer.net/" },
      ]} />

      <style>{`
        .interpreter-small { font-size: .9rem; margin: 0; }
        .interpreter-errtext { color: var(--pain); }
        .interpreter-ok { color: var(--good); }
        .interpreter-tree, .interpreter-tree ul { list-style: none; margin: 0; padding: 0; }
        .interpreter-tree ul { padding-left: 14px; border-left: 1px dashed var(--line); margin-left: 8px; }
        .interpreter-node { padding-top: 4px; }
        .interpreter-box { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--surface); padding: 3px 6px; transition: opacity .2s; }
        .interpreter-node.skipped > .interpreter-box { opacity: .45; border-style: dashed; }
        .interpreter-node.err > .interpreter-box { border-color: var(--pain); background: var(--pain-bg); }
        .interpreter-op { font-family: var(--f-code); font-size: .7rem; font-weight: 700; color: var(--accent); min-width: 2.4em; }
        .interpreter-box code { font-size: .72rem; }
        .interpreter-tools { display: inline-flex; gap: 4px; margin-left: auto; }
        .interpreter-tools .pg-btn { padding: 1px 6px; font-size: .72rem; }
        .interpreter-badge { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; padding: 1px 5px; border: 1px solid var(--line); }
        .interpreter-badge.yes { color: var(--good); border-color: var(--good); background: var(--good-bg); }
        .interpreter-badge.no { color: var(--ink-2); }
        .interpreter-badge.err { color: var(--pain); border-color: var(--pain); }
        .interpreter-badge.skip { color: var(--ink-2); border-style: dashed; }
        .interpreter-users { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px; }
        .interpreter-user { display: grid; grid-template-columns: 1fr auto; text-align: left; gap: 0 6px; border: 1px solid var(--line); background: var(--surface); padding: 4px 6px; font-size: .8rem; }
        .interpreter-user span { grid-column: 1; font-family: var(--f-code); font-size: .62rem; color: var(--ink-2); }
        .interpreter-user i { grid-row: 1 / span 2; grid-column: 2; align-self: center; font-style: normal; font-family: var(--f-code); font-size: .62rem; text-transform: uppercase; }
        .interpreter-user.yes { background: var(--good-bg); }
        .interpreter-user.yes i { color: var(--good); }
        .interpreter-user.err { background: var(--pain-bg); }
        .interpreter-user.err i { color: var(--pain); }
        .interpreter-user.want { outline: 2px dashed var(--accent); outline-offset: -3px; }
        .interpreter-user.on { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
        .interpreter-code { display: block; white-space: pre-wrap; word-break: break-word; font-size: .74rem; padding: 6px 8px; }
        @media (prefers-reduced-motion: reduce) { .interpreter-box { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
