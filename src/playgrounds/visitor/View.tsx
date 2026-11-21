"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  DESIGNS, OP_NAME, RES_NAME, STACK, build, cell, estimate, init, ops, requestDone, step, traceOf, trueEstimate, types,
  type Action, type Design, type Res, type State,
} from "./model";

const CSS = `
.visitor-grid { width: 100%; border-collapse: collapse; table-layout: fixed; font-family: var(--f-code); font-size: .64rem; }
.visitor-grid th, .visitor-grid td { border: 1px solid var(--line); padding: 4px 3px; text-align: center; vertical-align: middle; overflow-wrap: anywhere; }
.visitor-grid thead th { font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-2); background: var(--surface); }
.visitor-grid th[scope="row"] { text-align: left; color: var(--ink); background: var(--surface); width: 24%; }
.visitor-grid td { background: var(--bg); }
.visitor-grid th.file { color: var(--accent); }
.visitor-grid th.edited { background: var(--pain-bg); color: var(--pain); }
.visitor-grid th.created { background: var(--good-bg); color: var(--good); }
.visitor-grid.by-col td.col-group, .visitor-grid.by-col thead th.col-group { border-left: 2px solid var(--accent); border-right: 2px solid var(--accent); }
.visitor-grid.by-row tr.row-group > * { border-top: 2px solid var(--accent); border-bottom: 2px solid var(--accent); }
.visitor-grid tr.iface > * { background: var(--hl); }
.visitor-grid td.done { color: var(--good); }
.visitor-grid td.fresh { background: var(--good-bg); color: var(--good); }
.visitor-grid td.todo { outline: 2px dashed var(--accent); outline-offset: -3px; }
.visitor-grid .pg-btn { padding: 1px 5px; font-size: .68rem; font-family: var(--f-code); }
.visitor-file { display: block; font-size: .56rem; letter-spacing: .04em; text-transform: none; font-weight: 400; }
.visitor-build { margin: 0; font-family: var(--f-code); font-size: .72rem; padding: 6px 8px; border-left: 3px solid var(--good); background: var(--good-bg); color: var(--good); }
.visitor-build.fail { border-left-color: var(--pain); background: var(--pain-bg); color: var(--pain); }
.visitor-build ul { margin: 4px 0 0; padding-left: 1.2em; }
.visitor-stack { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.visitor-stack .pg-btn[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.visitor-trace { display: grid; gap: 6px; }
@media (prefers-reduced-motion: no-preference) {
  .visitor-grid td.fresh { transition: background-color .25s var(--ease); }
}
`;

const EXT: Record<Lang, string> = { go: "go", python: "py", typescript: "ts", rust: "rs" };
const VISIT: Record<Lang, (r: Res) => string> = {
  go: (r) => `Visit${RES_NAME[r]}`,
  python: (r) => `visit_${r === "lb" ? "load_balancer" : r}`,
  typescript: (r) => `visit${RES_NAME[r]}`,
  rust: (r) => `visit_${r === "lb" ? "load_balancer" : r}`,
};
const fileName = (lang: Lang, d: Design, key: string) => {
  const e = EXT[lang];
  if (d === "methods") return `${key === "lb" ? "load_balancer" : key}.${e}`;
  if (key === "iface") return `visitor.${e}`;
  return `${key}_visitor.${e}`;
};

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

/* ---------------- the matrix: one cell per (operation, resource type) ---------------- */

function Matrix({ d, st, lang, dispatch }: { d: Design; st: State; lang: Lang; dispatch: (a: Action) => void }) {
  const s = st[d];
  const cols = types(st);
  const rows = ops(st);
  const fileClass = (file: string) => (s.created.includes(file) ? " created" : s.edited.includes(file) ? " edited" : "");
  const open = st.request < 2;
  return (
    <table className={"visitor-grid " + (d === "methods" ? "by-col" : "by-row")}>
      <caption className="muted" style={{ captionSide: "bottom", textAlign: "left", paddingTop: 4 }}>
        {d === "methods" ? "Each column is one file: a resource type with all its operations." : "Each row is one file: an operation with a method per resource type."}
      </caption>
      <thead>
        <tr>
          <th scope="col">op \ type</th>
          {cols.map((r) => (
            <th key={r} scope="col" className={d === "methods" ? "col-group file" + fileClass(r) : ""}>
              {RES_NAME[r]}
              {d === "methods" && <span className="visitor-file">{fileName(lang, d, r)}</span>}
              {d === "visitor" && r === "queue" && <span className={"visitor-file" + fileClass("queue")}>queue.{EXT[lang]} · Accept</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {d === "visitor" && (
          <tr className="iface row-group">
            <th scope="row" className={"file" + fileClass("visitor interface")}>Visitor<span className="visitor-file">{fileName(lang, d, "iface")}</span></th>
            {cols.map((r) => {
              const declared = r !== "queue" || s.iface;
              return (
                <td key={r} className={!declared && open ? "todo" : r === "queue" && declared ? "fresh" : "done"}>
                  {declared ? VISIT[lang](r) : open
                    ? <button className="pg-btn" onClick={() => dispatch({ type: "declareQueue" })} aria-label={`Declare ${VISIT[lang](r)} in the Visitor interface`}>+ {VISIT[lang](r)}</button>
                    : "·"}
                </td>
              );
            })}
          </tr>
        )}
        {rows.map((op) => (
          <tr key={op} className={d === "visitor" ? "row-group" : ""}>
            <th scope="row" className={d === "visitor" ? "file" + fileClass(`${op} visitor`) : ""}>
              {OP_NAME[op]}
              {d === "visitor" && <span className="visitor-file">{fileName(lang, d, op)}</span>}
            </th>
            {cols.map((r) => {
              const has = s.cells.includes(cell(op, r));
              const fresh = has && (op === "cost" || r === "queue");
              return (
                <td key={r} className={(d === "methods" ? "col-group " : "") + (has ? (fresh ? "fresh" : "done") : open ? "todo" : "")}>
                  {has ? "✓" : open
                    ? <button className="pg-btn" onClick={() => dispatch({ type: "write", design: d, op, res: r })} aria-label={`Write ${OP_NAME[op]} for ${RES_NAME[r]} in the ${d === "methods" ? "methods" : "visitor"} design`}>+</button>
                    : "·"}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- one design ---------------- */

const INFO: Record<Design, { title: string; sub: string }> = {
  methods: { title: "Methods on resources", sub: "Every resource type implements Validate, Render and Cost itself." },
  visitor: { title: "Visitor", sub: "Resource types only have Accept. Each operation is a visitor with one Visit method per type." },
};

function Panel({ d, st, lang, dispatch }: { d: Design; st: State; lang: Lang; dispatch: (a: Action) => void }) {
  const s = st[d];
  const issues = build(st, d);
  const errors = issues.filter((i) => !i.silent);
  const silent = issues.filter((i) => i.silent);
  const est = estimate(st, d);
  const truth = trueEstimate(st);
  return (
    <section className="pg-side" aria-label={INFO[d].title}>
      <header>
        <h4>{INFO[d].title}</h4>
        {st.request < 2 && <span className={"pg-status" + (issues.length === 0 ? " done" : "")}>{issues.length === 0 ? "Done" : "Not done"}</span>}
      </header>
      <p className="muted">{INFO[d].sub}</p>
      <Matrix d={d} st={st} lang={lang} dispatch={dispatch} />
      {d === "visitor" && st.request < 2 && (
        <div className="pg-actions">
          <button className="pg-btn" aria-pressed={s.defaults} onClick={() => dispatch({ type: "toggleDefaults" })}
            title="Give every visitor a base with empty Visit methods, so a missing one still compiles.">
            Empty default visits: {s.defaults ? "on" : "off"}
          </button>
        </div>
      )}
      <div className={"visitor-build" + (errors.length || silent.length ? " fail" : "")} aria-live="polite">
        {errors.length
          ? <>Build fails, {n(errors.length, "error")}:<ul>{errors.slice(0, 3).map((e) => <li key={e.text}>{e.text}</li>)}{errors.length > 3 && <li>…and {errors.length - 3} more</li>}</ul></>
          : <>Build passes. Cost estimate: ${est}/month{est !== truth ? `, but the real cost is $${truth}` : ""}.
            {silent.length > 0 && <ul>{silent.map((e) => <li key={e.text}>{e.text}</li>)}</ul>}</>}
      </div>
      <dl className="pg-stats">
        <div className={s.edited.length ? "bad" : ""}><dt>Existing files edited</dt><dd>{s.edited.length}</dd></div>
        <div><dt>New files</dt><dd>{s.created.length}</dd></div>
        <div><dt>Edited</dt><dd>{s.edited.length ? s.edited.map((f) => f.replace(" visitor", "").replace(" interface", "")).join(", ") : "none"}</dd></div>
        <div className={silent.length ? "bad" : ""}><dt>Silent gaps</dt><dd>{silent.length}</dd></div>
      </dl>
    </section>
  );
}

/* ---------------- trace one call ---------------- */

function Trace({ st, dispatch, reduced }: { st: State; dispatch: (a: Action) => void; reduced: boolean }) {
  const present = STACK.filter((x) => types(st).includes(x.res));
  return (
    <div className="pg-card">
      <span className="label">Trace one Cost call through the stack</span>
      <div className="visitor-stack" role="group" aria-label="Resources in the stack">
        {present.map((x) => (
          <button key={x.id} className="pg-btn" aria-pressed={st.trace === x.res} onClick={() => dispatch({ type: "trace", res: x.res })}>
            {x.res === "network" ? x.id : `└ ${x.id}`}
          </button>
        ))}
      </div>
      <div className="visitor-trace" aria-live="polite">
        {DESIGNS.map((d) => {
          const t = traceOf(st, d, st.trace);
          return (
            <div key={`${d}-${st.trace}-${t.hops.length}`} className={"pg-entry" + (t.ok ? " ok" : " fail") + (reduced ? "" : " fresh")}>
              <div className="pg-path" aria-hidden="true">
                <span>{d === "methods" ? "methods" : "visitor"}</span>
                {t.hops.map((h, j) => <span key={j} style={{ animationDelay: `${j * 120}ms` }}>{h}</span>)}
              </div>
              <p>{t.note}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- requests ---------------- */

const REQUESTS = [
  {
    title: "Add a cost estimate",
    kind: "A new operation",
    why: "Finance wants every stack's monthly cost before it deploys. The plan tool must estimate the cost of each resource and add them up.",
    task: "Write Cost for every resource type, in both designs.",
  },
  {
    title: "Add a Queue resource",
    kind: "A new resource type",
    why: "The platform team adds message queues. The stack now has emails-queue, and every operation must handle it.",
    task: "Make Validate, Render and Cost work for Queue, in both designs.",
  },
];

const PREDICT: Record<number, { q: string; options: { value: string; label: string }[]; answer: string; explain: string }> = {
  0: {
    q: "Adding the Cost operation: how many existing files does each design edit?",
    options: [{ value: "a", label: "Methods 4, Visitor 0" }, { value: "b", label: "Both 4" }, { value: "c", label: "Methods 0, Visitor 4" }],
    answer: "a",
    explain: "The cells are the same four in both designs. Methods on resources puts one in each resource file. Visitor puts all four in one new file, CostVisitor, and touches nothing that already works.",
  },
  1: {
    q: "Adding the Queue type: how many existing files does the Visitor design edit?",
    options: [{ value: "0", label: "0" }, { value: "1", label: "1" }, { value: "4", label: "4" }],
    answer: "4",
    explain: "The Visitor interface gains VisitQueue, and so does every visitor: Validate, Render and Cost. Methods on resources just adds queue as one new file. Visitor makes operations cheap and types expensive.",
  },
};

function Result({ st }: { st: State }) {
  const m = st.methods, v = st.visitor;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What this request cost</span>
      <p><b>Methods on resources:</b> {n(m.edited.length, "existing file")} edited, {n(m.created.length, "new file")}.</p>
      <p><b>Visitor:</b> {n(v.edited.length, "existing file")} edited, {n(v.created.length, "new file")}.</p>
      <p className="pg-takeaway">
        {st.request === 0
          ? "A new operation is one new visitor. Every resource type, and the code that already validates and renders them, stayed untouched."
          : "A new resource type goes the other way. With methods on resources it is one new file. With Visitor, the interface and every visitor change."}
      </p>
    </div>
  );
}

export default function VisitorPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const done = requestDone(st);
  const req = REQUESTS[Math.min(st.request, 1)];
  const pr = PREDICT[st.request];

  return (
    <PgFrame title="Infrastructure plan: operations × resource types" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      {st.request < 2 ? (
        <div className="pg-req">
          <span className="label">Request {st.request + 1} of 2 · {req.kind}</span>
          <h3>{req.title}</h3>
          <p>{req.why}</p>
          <p className="pg-rule"><b>{req.task}</b> Click a dashed cell to write that method. Red file names were edited, green ones are new.</p>
          {pr && (
            <PgPredict question={pr.q} options={pr.options} value={st.predictions[st.request] ?? null} answer={pr.answer}
              onChange={(v) => dispatch({ type: "predict", request: st.request, value: v })} revealed={done} explain={pr.explain} />
          )}
          {done && (
            <>
              <Result st={st} />
              <PgButton primary onClick={() => dispatch({ type: "next" })}>{st.request === 0 ? "Next request →" : "See the summary →"}</PgButton>
            </>
          )}
        </div>
      ) : (
        <div className="pg-req">
          <span className="label">Summary in your numbers</span>
          <h3>Which way the table grows</h3>
          {(() => {
            const [r1, r2] = st.results;
            return (
              <ul>
                <li><b>New operation (Cost):</b> methods on resources edited {n(r1.methods.edited, "existing file")}; Visitor edited {r1.visitor.edited} and added {n(r1.visitor.created, "file")}.</li>
                <li><b>New type (Queue):</b> methods on resources edited {r2.methods.edited} and added {n(r2.methods.created, "file")}; Visitor edited {n(r2.visitor.edited, "existing file")}.</li>
                <li><b>So:</b> choose Visitor when the set of types is stable and operations keep coming, as in a compiler or a plan tool. When types keep coming, keep the methods on the types.</li>
              </ul>
            );
          })()}
          <PgButton onClick={() => dispatch({ type: "reset" })}>Start over</PgButton>
        </div>
      )}

      <div className="pg-sides">
        {DESIGNS.map((d) => <Panel key={d} d={d} st={st} lang={lang} dispatch={dispatch} />)}
      </div>

      <Trace st={st} dispatch={dispatch} reduced={reduced} />

      <PgSources links={[
        { title: "Refactoring.Guru on Visitor", href: "https://refactoring.guru/design-patterns/visitor" },
        { title: "NYU OOP notes on the expression problem and double dispatch", href: "https://cs.nyu.edu/~wies/teaching/oop-13/notes1017.html" },
      ]} />
    </PgFrame>
  );
}

