"use client";
import type { ReactNode } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  DESIGNS, FIX_LABEL, FIX_STEP, NAME, STEPS, TICKETS, activeFixes, drift, init, step, totals,
  type Action, type Design, type Fix, type Imp, type MonthResult, type State, type StepId,
} from "./model";

const CSS = `
.template-method-grid { width: 100%; border-collapse: collapse; table-layout: fixed; font-family: var(--f-code); font-size: .66rem; }
.template-method-grid th, .template-method-grid td { border: 1px solid var(--line); padding: 4px 4px; vertical-align: top; text-align: left; overflow-wrap: anywhere; }
.template-method-grid th { font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); background: var(--surface); }
.template-method-grid th[scope="row"] { color: var(--ink); width: 22%; }
.template-method-grid td { background: var(--surface); }
.template-method-grid tr.base td, .template-method-grid tr.base th { background: var(--hl); }
.template-method-grid td.inherit { color: var(--ink-2); background: var(--bg); }
.template-method-grid td.hot { outline: 2px dashed var(--accent); outline-offset: -3px; }
.template-method-chip { display: inline-block; margin: 1px 2px 1px 0; padding: 0 4px; border: 1px solid var(--line); background: var(--bg); }
.template-method-chip.ok { color: var(--good); background: var(--good-bg); border-color: var(--good); }
.template-method-chip.bad { color: var(--pain); background: var(--pain-bg); border-color: var(--pain); }
.template-method-grid .pg-btn { padding: 1px 6px; font-size: .7rem; font-family: var(--f-code); }
.template-method-run { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.template-method-copy { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: .9rem; }
@media (prefers-reduced-motion: no-preference) {
  .template-method-chip.ok { transition: background-color .25s var(--ease); }
}
`;

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const Chip = ({ tone, children }: { tone?: "ok" | "bad"; children: ReactNode }) => <span className={"template-method-chip" + (tone ? ` ${tone}` : "")}>{children}</span>;

/* ---------------- one cell of a shared step ---------------- */

function StepCell({ fixes, stepId, st, onPatch, label }: { fixes: Fix[]; stepId: StepId; st: State; onPatch: () => void; label: string }) {
  const t = TICKETS[st.ticket];
  const active = st.ticket < TICKETS.length ? activeFixes(st.ticket) : activeFixes(TICKETS.length - 1);
  const mine = active.filter((f) => FIX_STEP[f] === stepId);
  const canPatch = st.phase === "work" && t?.kind === "fix" && t.fix && FIX_STEP[t.fix] === stepId && !fixes.includes(t.fix);
  return (
    <td className={canPatch ? "hot" : ""}>
      {mine.map((f) => fixes.includes(f)
        ? <Chip key={f} tone="ok">{FIX_LABEL[f]}</Chip>
        : (canPatch && t.fix === f ? null : <Chip key={f} tone="bad">no {FIX_LABEL[f]}</Chip>))}
      {canPatch && <button className="pg-btn" onClick={onPatch} aria-label={`Add ${FIX_LABEL[t.fix!]} to ${stepId} in ${label}`}>+ {FIX_LABEL[t.fix!]}</button>}
      {!mine.length && !canPatch && <span className="muted">·</span>}
    </td>
  );
}

/* ---------------- the copied codebase ---------------- */

function CopiedGrid({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const showHook = st.ticket >= 3;
  const working = st.phase === "work";
  const imps = Object.keys(st.copied.imps) as Imp[];
  return (
    <table className="template-method-grid">
      <thead>
        <tr><th scope="col">file</th><th scope="col">parse</th>{STEPS.map((s) => <th key={s} scope="col">{s}</th>)}{showHook && <th scope="col">balance</th>}</tr>
      </thead>
      <tbody>
        {imps.map((imp) => {
          const c = st.copied.imps[imp]!;
          return (
            <tr key={imp}>
              <th scope="row">{NAME[imp]}</th>
              <td>own</td>
              {STEPS.map((s) => <StepCell key={s} fixes={c.fixes} stepId={s} st={st} label={`the ${NAME[imp]} copy`} onPatch={() => dispatch({ type: "patch", design: "copied", imp })} />)}
              {showHook && (
                <td className={imp === "bank" && working && TICKETS[st.ticket]?.kind === "hook" && !c.balanceCheck ? "hot" : ""}>
                  {c.balanceCheck
                    ? <Chip tone={imp === "bank" ? "ok" : "bad"}>{imp === "bank" ? "check" : "check (copied)"}</Chip>
                    : imp === "bank" && working && TICKETS[st.ticket]?.kind === "hook"
                      ? <PgButton onClick={() => dispatch({ type: "addCheck" })}>+ check</PgButton>
                      : <span className="muted">·</span>}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---------------- the template codebase ---------------- */

function TemplateGrid({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const tp = st.template;
  const showHook = st.ticket >= 3;
  const hookTicket = st.phase === "work" && TICKETS[st.ticket]?.kind === "hook";
  return (
    <table className="template-method-grid">
      <thead>
        <tr><th scope="col">class</th><th scope="col">parse</th>{STEPS.map((s) => <th key={s} scope="col">{s}</th>)}{showHook && <th scope="col">before_load</th>}</tr>
      </thead>
      <tbody>
        <tr className="base">
          <th scope="row">Importer (base)</th>
          <td>abstract</td>
          {STEPS.map((s) => <StepCell key={s} fixes={tp.fixes} stepId={s} st={st} label="the base Importer" onPatch={() => dispatch({ type: "patch", design: "template" })} />)}
          {showHook && (
            <td className={hookTicket && !tp.hook ? "hot" : ""}>
              {tp.hook ? <Chip tone="ok">run() calls it</Chip> : hookTicket
                ? <PgButton onClick={() => dispatch({ type: "addHook" })}>+ call in run()</PgButton>
                : <Chip tone="bad">never called</Chip>}
            </td>
          )}
        </tr>
        {tp.imps.map((imp) => (
          <tr key={imp}>
            <th scope="row">{NAME[imp]}</th>
            <td>own</td>
            {STEPS.map((s) => <td key={s} className="inherit">↑ base</td>)}
            {showHook && (
              <td className={imp === "bank" && hookTicket && !tp.bankOverride ? "hot" : ""}>
                {imp !== "bank" ? <span className="muted">empty default</span>
                  : tp.bankOverride ? <Chip tone={tp.hook ? "ok" : "bad"}>override{tp.hook ? "" : " (unused)"}</Chip>
                  : hookTicket ? <PgButton onClick={() => dispatch({ type: "overrideBank" })}>+ override</PgButton>
                  : <span className="muted">empty default</span>}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- per design panel ---------------- */

const INFO: Record<Design, { title: string; sub: string }> = {
  copied: { title: "Copied importers", sub: "Each file type has its own full pipeline: open, parse, validate, transform, load." },
  template: { title: "Template method", sub: "The base Importer runs the steps in order. Each file type writes parse, and may override a hook." },
};

function Panel({ d, st, dispatch, result }: { d: Design; st: State; dispatch: (a: Action) => void; result?: MonthResult }) {
  const t = TICKETS[st.ticket];
  const newTicket = st.phase === "work" && t?.kind === "new";
  const all = totals(st)[d];
  return (
    <section className="pg-side" aria-label={INFO[d].title}>
      <header><h4>{INFO[d].title}</h4></header>
      <p className="muted">{INFO[d].sub}</p>
      {d === "copied" ? <CopiedGrid st={st} dispatch={dispatch} /> : <TemplateGrid st={st} dispatch={dispatch} />}
      {newTicket && d === "copied" && !st.copied.imps.stripe && (
        <div className="template-method-copy">
          <span>Start Stripe as a copy of</span>
          {(["csv", "json", "bank"] as Imp[]).map((src) => <PgButton key={src} onClick={() => dispatch({ type: "copyFrom", src })}>{NAME[src]}</PgButton>)}
        </div>
      )}
      {newTicket && d === "template" && !st.template.imps.includes("stripe") && (
        <div className="template-method-copy">
          <PgButton onClick={() => dispatch({ type: "writeParse" })}>+ StripeImporter with parse only</PgButton>
        </div>
      )}
      <dl className="pg-stats">
        <div><dt>Edits this month</dt><dd>{st[d].tally.edits - st.startEdits[d]}</dd></div>
        <div><dt>Edits in total</dt><dd>{st[d].tally.edits}</dd></div>
        <div className={d === "copied" && drift(st) ? "bad" : ""}><dt>Copies out of step</dt><dd>{d === "copied" ? drift(st) : "one copy"}</dd></div>
        <div className={all.problems ? "bad" : ""}><dt>Bad imports so far</dt><dd>{all.problems}</dd></div>
      </dl>
      {result && (
        <>
          <span className="label">Month-end import</span>
          <div className="pg-log" aria-live="polite">
            {(["csv", "json", "bank", "stripe"] as Imp[]).filter((imp) => imp !== "stripe" || result.ticket >= 4).map((imp) => {
              const ps = result[d].problems.filter((p) => p.imp === imp);
              return (
                <div key={imp} className={"pg-entry" + (ps.length ? " fail" : " ok")}>
                  <div className="pg-path" aria-hidden="true"><span>{imp}.file</span><span>{d === "copied" ? `${NAME[imp]} copy` : "Importer.run"}</span><span>ledger</span><span>{ps.length ? "✗" : "✓"}</span></div>
                  <p>{ps.length ? `${NAME[imp]}: ${ps.map((p) => p.text).join("; ")}.` : `${NAME[imp]}: imported cleanly.`}</p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------- what each month showed ---------------- */

function Explain({ r, st }: { r: MonthResult; st: State }) {
  const t = TICKETS[r.ticket];
  const cBad = new Set(r.copied.problems.map((p) => p.imp)).size;
  const tBad = new Set(r.template.problems.map((p) => p.imp)).size;
  let take: string;
  if (t.kind === "fix") {
    const where = FIX_STEP[t.fix!];
    take = r.template.edits === 0 && tBad > 0
      ? `You left the template design alone, so every importer there still has the bug. One edit to the base ${where} would have fixed all of them.`
      : cBad > 0 && tBad === 0
        ? `The ticket named ${NAME[t.reported!]}, and the copied design has a separate ${where} in every file. Nothing pointed you at the other copies. In the template design there is only one ${where}, so the fix landed in the base and every importer got it.`
        : cBad === 0 && tBad === 0
          ? `You found every copy, so both designs are clean. The copied design took ${n(r.copied.edits, "edit")} to the template's ${n(r.template.edits, "edit")}, and you had to know where the copies were.`
          : "Some importers still have the bug. In the copied design, every copy needs its own edit.";
  } else if (t.kind === "hook") {
    const never = st.template.bankOverride && !st.template.hook;
    take = never
      ? "The Bank override exists, but run() never calls before_load, so the check never ran and nothing warned you. A hook only works if the template calls it."
      : r.copied.edits === 0 || r.template.edits < 2
        ? "The balance check is missing on at least one side, so a statement with a missing day got in. In the template design it takes two edits: the hook call in run() and the override in Bank."
      : `This time the copy was cheaper: ${n(r.copied.edits, "edit")} in Bank's own file. The template needed ${n(r.template.edits, "edit")}, one of them in run(), which every importer executes. The template pays when one variant needs a step the others do not.`;
  } else {
    const src = st.copied.tally.places.find((p) => p.startsWith("stripe (copy of"));
    take = src
      ? `Your Stripe importer is a ${src.replace("stripe (", "").replace(")", "")}, so it starts with exactly the fixes that copy had, and its quirks. The templated Stripe importer wrote parse and got every shared fix from the base.`
      : "No importer, no payouts. Add one in each design and run again next time.";
  }
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Month {r.ticket + 1} in your numbers</span>
      <p><b>Copied:</b> {n(r.copied.edits, "edit")}, {n(cBad, "importer")} with bad imports. <b>Template:</b> {n(r.template.edits, "edit")}, {n(tBad, "importer")} with bad imports.</p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

/* ---------------- predictions ---------------- */

const PREDICT: Record<number, { q: string; options: { value: string; label: string }[]; answer: string; explain: string }> = {
  0: {
    q: "You fix validate in the CSV importer only, as the ticket says, in both codebases. After the month-end run, where do duplicates still get in?",
    options: [{ value: "none", label: "Nowhere" }, { value: "copied", label: "Copied: JSON and Bank" }, { value: "both", label: "Both designs: JSON and Bank" }],
    answer: "copied",
    explain: "In the copied design, each importer has its own validate, so the fix stays in CSV. In the template design, the CSV importer has no validate of its own: clicking it edits the one in the base.",
  },
  3: {
    q: "Only bank statements need the balance check. Which design needs fewer edits?",
    options: [{ value: "copied", label: "Copied" }, { value: "same", label: "The same" }, { value: "template", label: "Template" }],
    answer: "copied",
    explain: "The copy gets one edit in its own file. The template needs a hook call in run() and an override in Bank, because the base fixes the order of steps and every extension point has to be declared there.",
  },
};

/* ---------------- the playground ---------------- */

export default function TemplateMethodImporters() {
  const { state: st, dispatch } = useModel(step, init);
  const t = TICKETS[st.ticket];
  const result = st.phase === "ran" ? st.results[st.results.length - 1] : undefined;
  const pr = PREDICT[st.ticket];
  const finished = st.ticket >= TICKETS.length;
  const tot = totals(st);

  return (
    <PgFrame title="Five months of importer tickets" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      {!finished ? (
        <div className="pg-req">
          <span className="label">Month {st.ticket + 1} of {TICKETS.length}{t.reported ? ` · reported against ${NAME[t.reported]}` : ""}</span>
          <h3>{t.title}</h3>
          <p>{t.why}</p>
          <p className="pg-rule"><b>Make the change in both codebases, then run the month-end import.</b> The import takes every partner&apos;s file, and the problem in this ticket is in all of them.</p>
          {pr && (
            <PgPredict question={pr.q} options={pr.options} value={(st.predictions[st.ticket] ?? null)} answer={pr.answer}
              onChange={(v) => dispatch({ type: "predict", ticket: st.ticket, value: v })} revealed={st.phase === "ran"} explain={pr.explain} />
          )}
          <div className="template-method-run">
            {st.phase === "work"
              ? <PgButton primary onClick={() => dispatch({ type: "run" })}>Ship both and run month-end import</PgButton>
              : <PgButton primary onClick={() => dispatch({ type: "next" })}>{st.ticket + 1 < TICKETS.length ? "Next month →" : "See the summary →"}</PgButton>}
            {st.phase === "work" && <span className="muted">Dashed cells are where this ticket can be fixed.</span>}
          </div>
          {result && <Explain r={result} st={st} />}
        </div>
      ) : (
        <div className="pg-req">
          <span className="label">Five months in your numbers</span>
          <h3>What the tickets cost</h3>
          <ul>
            <li><b>Copied importers:</b> {n(tot.copied.edits, "edit")}, {n(tot.copied.problems, "bad import")}, and {n(drift(st), "fix", "fixes")} that one copy has and another lacks.</li>
            <li><b>Template method:</b> {n(tot.template.edits, "edit")}, {n(tot.template.problems, "bad import")}. Shared fixes landed once and reached every importer, including Stripe.</li>
            <li><b>The one month the copy won:</b> the bank-only balance check, {n(st.results[3]?.copied.edits ?? 0, "edit")} against {n(st.results[3]?.template.edits ?? 0, "edit")}. A template fixes the order of steps for everyone, so a step only one importer needs must be declared in the base as a hook.</li>
          </ul>
          <PgButton onClick={() => dispatch({ type: "reset" })}>Start over</PgButton>
        </div>
      )}

      <div className="pg-sides">
        {DESIGNS.map((d) => <Panel key={d} d={d} st={st} dispatch={dispatch} result={result} />)}
      </div>

      <PgSources links={[
        { title: "Refactoring.Guru on Template Method", href: "https://refactoring.guru/design-patterns/template-method" },
        { title: "Wikipedia's Template method pattern", href: "https://en.wikipedia.org/wiki/Template_method_pattern" },
      ]} />
    </PgFrame>
  );
}
