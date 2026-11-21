"use client";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, FUNC, FUNCS, MEMBERS, NEW_FIELD, NEW_MEMBER, OPTIONAL_FIELDS, PREDICT_ANSWER, init, optionalOutcome, shapes, step, tally,
  unionErrors, unionOutcome, type Action, type FuncId, type Predict, type State,
} from "./model";

const FIELDS: Record<string, string> = { pending: "", authorized: "authCode: string", captured: "authCode: string; capturedAt: Date", failed: "reason: string", refunded: "refundId: string" };

function UnionType({ added }: { added: boolean }) {
  return (
    <pre className="du-type"><code>
      {"type Payment =\n"}
      {MEMBERS.map((m) => `  | { status: "${m}"${FIELDS[m] ? "; " + FIELDS[m] : ""} }\n`).join("")}
      {added && <span className="du-new">{`  | { status: "${NEW_MEMBER}"; redirectUrl: string }\n`}</span>}
    </code></pre>
  );
}

function OptionalType({ added }: { added: boolean }) {
  return (
    <pre className="du-type"><code>
      {"type Payment = {\n  id: string;\n  status: string;\n"}
      {OPTIONAL_FIELDS.map((f) => `  ${f}?: ${f === "capturedAt" ? "Date" : "string"};\n`).join("")}
      {added && <span className="du-new">{`  ${NEW_FIELD}?: string;\n`}</span>}
      {"};"}
    </code></pre>
  );
}

function UnionCard({ st, f, dispatch }: { st: State; f: FuncId; dispatch: (a: Action) => void }) {
  const err = unionErrors(st).includes(f);
  const handled = st.handled.includes(f);
  const never = st.ending[f] === "never";
  const out = st.shipped ? unionOutcome(st, f) : null;
  return (
    <li className={"du-card" + (err ? " err" : "") + (out ? (out.ok ? " good" : " bad") : "")}>
      <span className="du-file">{FUNC[f].file}</span>
      <code className="du-sig">{FUNC[f].sig}</code>
      <code className="du-code">
        {"switch (p.status) {  …"}
        {handled && <><br /><span className="du-new">{"  " + FUNC[f].newCase}</span></>}
        <br />{"  " + (never ? "default: return assertNever(p);" : FUNC[f].defaultCode)}
        <br />{"}"}
      </code>
      {err
        ? <p className="du-error">error: Argument of type &apos;RequiresAction&apos; is not assignable to parameter of type &apos;never&apos;.</p>
        : <p className="du-okline">compiles ✓</p>}
      <div className="du-actions">
        {err && <PgButton primary onClick={() => dispatch({ type: "handle", f })}>Add the requires_action case</PgButton>}
        {!handled && (
          <button className="pg-btn ghost" onClick={() => dispatch({ type: "ending", f, ending: never ? "default" : "never" })}>
            {never ? "Use a default branch" : "End with assertNever"}
          </button>
        )}
      </div>
      {out && <p className="du-out"><b>{out.ok ? "✓" : "✗"}</b> 3-D Secure payment: {out.text}</p>}
      {st.shipped && !out && <p className="du-out">Build failed. Nothing deployed, nobody affected.</p>}
    </li>
  );
}

function OptionalCard({ st, f, dispatch }: { st: State; f: FuncId; dispatch: (a: Action) => void }) {
  const read = st.audited.includes(f);
  const fixed = st.fixed.includes(f);
  const out = st.shipped ? optionalOutcome(st, f) : null;
  const preview = optionalOutcome(st, f);
  return (
    <li className={"du-card" + (out ? (out.ok ? " good" : " bad") : "")}>
      <span className="du-file">{FUNC[f].file}</span>
      <code className="du-sig">{FUNC[f].sig}</code>
      <code className="du-code">{fixed ? <span className="du-new">{`if (p.${NEW_FIELD}) return …; // added by hand`}</span> : null}{fixed && <br />}{FUNC[f].optCode}</code>
      <p className="du-okline">compiles ✓</p>
      <div className="du-actions">
        {!read && <button className="pg-btn ghost" onClick={() => dispatch({ type: "audit", f })}>Read it for requires_action</button>}
        {read && st.added && !fixed && !preview.ok && <PgButton onClick={() => dispatch({ type: "fix", f })}>Fix it by hand</PgButton>}
      </div>
      {read && !out && <p className="du-read">{st.added ? `For requires_action it returns ${preview.text}.` : "Nothing to check until the new state exists."}</p>}
      {out && <p className="du-out"><b>{out.ok ? "✓" : "✗"}</b> 3-D Secure payment: {out.text}</p>}
    </li>
  );
}

function Result({ st }: { st: State }) {
  if (!st.added) return null;
  const t = tally(st);
  const sh = shapes(st);
  let take: string;
  if (!st.shipped) take = "The union side names its gaps; the optional side compiles, and the gaps are still there. Ship to see what each does with a real 3-D Secure payment.";
  else if (st.shippedUnion && st.shippedUnion.errors > 0) take = `The union build failed with ${st.shippedUnion.errors} errors, so nothing shipped and no customer was affected. The optional build shipped, and ${t.optionalWrong} functions mishandle the new payment. Handle the flagged cases and ship again.`;
  else if (t.unionWrong > 0 && FUNCS.every((f) => st.ending[f] === "default")) take = "With a default branch in every switch the compiler had nothing to say, and the union side shipped the same kind of bugs as the optional side. The exhaustiveness check is the assertNever, not the union.";
  else if (t.unionWrong > 0) take = "The compiler flagged every switch that ends in assertNever. The one with a default branch stayed quiet and shipped a wrong answer. A default branch is a promise that every future state behaves like the default.";
  else if (t.optionalWrong > 0) take = `The union side is correct. The optional side still gets ${t.optionalWrong} of 5 wrong, and nothing in the build said which.`;
  else take = `Both sides are correct now. The compiler pointed you at ${t.unionEdited} union switches; on the optional side you had to read ${t.read} functions to find the ${t.optionalEdited} that needed a fix.`;
  return (
    <div className="pg-result">
      <span className="label">What this change cost</span>
      <p>
        Tagged union: {sh.union} possible shapes, {t.unionErrors} compile errors now, {t.unionEdited} switches edited, {t.unionWrong} wrong in production.
        {" "}Optional fields: {sh.optional} field combinations, 0 compile errors, {t.read} functions read by hand, {t.optionalEdited} fixed, {t.optionalWrong} wrong in production.
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function DiscriminatedUnionsPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const t = tally(st);
  const sh = shapes(st);

  return (
    <PgFrame title="Add a payment state" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The change request</span>
        <p>Banks in the EU require 3-D Secure. A payment can now wait in <code>requires_action</code> while the customer confirms it at <code>redirectUrl</code>. The same five functions read the payment in both models below.</p>
        <p className="pg-rule"><b>Add the state to both models, then ship and watch one 3-D Secure payment go through every function.</b></p>
      </div>

      <PgPredict<Predict>
        question="Four union switches end in assertNever and one has a default branch. After you add requires_action, how many compile errors does each model show?"
        options={[{ value: "five", label: "5 union, 5 optional" }, { value: "fourZero", label: "4 union, 0 optional" }, { value: "zero", label: "0 and 0" }]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.added}
        answer={PREDICT_ANSWER}
        explain={<>In the default branch of a switch over a union, the value has the type of every member not handled yet. assertNever demands that this be never, so a new member is an error there. A default that returns a value accepts it silently, and optional fields give the compiler no list of states at all.</>}
      />

      <div className="du-bar">
        <PgButton primary onClick={() => dispatch({ type: "add" })} disabled={st.added}>{st.added ? "requires_action added" : "Add requires_action to both"}</PgButton>
        <PgButton onClick={() => dispatch({ type: "ship" })} disabled={!st.added}>Ship it</PgButton>
      </div>

      <div className="du-cols">
        <section className="du-col" aria-label="Tagged union">
          <span className="label">Tagged union · {sh.union} shapes</span>
          <UnionType added={st.added} />
          <ul className="du-list">{FUNCS.map((f) => <UnionCard key={f} st={st} f={f} dispatch={dispatch} />)}</ul>
        </section>
        <section className="du-col" aria-label="Optional fields">
          <span className="label">Optional fields · {sh.optional} combinations</span>
          <OptionalType added={st.added} />
          <ul className="du-list">{FUNCS.map((f) => <OptionalCard key={f} st={st} f={f} dispatch={dispatch} />)}</ul>
        </section>
      </div>

      <dl className="pg-stats">
        <div className={t.unionErrors ? "bad" : ""}><dt>Union errors</dt><dd>{t.unionErrors}</dd></div>
        <div><dt>Optional errors</dt><dd>0</dd></div>
        <div className={st.shipped && t.unionWrong ? "bad" : ""}><dt>Union wrong</dt><dd>{st.shipped ? t.unionWrong : "–"}</dd></div>
        <div className={st.shipped && t.optionalWrong ? "bad" : ""}><dt>Optional wrong</dt><dd>{st.shipped ? t.optionalWrong : "–"}</dd></div>
      </dl>

      <Result st={st} />

      <div className="du-challenges">
        <span className="label">Challenges</span>
        <ul>
          {CHALLENGES.map((c) => <li key={c.id} className={st.done.includes(c.id) ? "done" : ""}>{st.done.includes(c.id) ? "✓ " : "○ "}{c.text}</li>)}
        </ul>
      </div>

      <PgSources links={[
        { title: "the TypeScript Handbook on exhaustiveness checking", href: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking" },
        { title: "Richard Feldman's Making Impossible States Impossible", href: "https://www.youtube.com/watch?v=IcgmSRJHu_8" },
        { title: "Kent C. Dodds, Make Impossible States Impossible", href: "https://kentcdodds.com/blog/make-impossible-states-impossible" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.du-bar { display: flex; flex-wrap: wrap; gap: 8px; }
.du-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 640px) { .du-cols { grid-template-columns: 1fr; } }
.du-col { display: grid; gap: 8px; align-content: start; min-width: 0; }
.du-type { margin: 0; border: 1px solid var(--line); background: var(--bg); padding: 8px 10px; font-size: .72rem; overflow-x: auto; }
.du-new { color: var(--good); font-weight: 600; }
.du-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.du-card { border: 1px solid var(--line); background: var(--surface); padding: 8px 10px; display: grid; gap: 4px; transition: border-color .2s var(--ease), background .2s var(--ease); }
.du-card.err { border-color: var(--pain); background: var(--pain-bg); }
.du-card.good { border-color: var(--good); }
.du-card.bad { border-color: var(--pain); background: var(--pain-bg); }
.du-file { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.du-sig { font-size: .76rem; font-weight: 600; }
.du-code { font-size: .7rem; color: var(--ink-2); white-space: pre-wrap; word-break: break-word; }
.du-error { margin: 0; font-family: var(--f-code); font-size: .7rem; color: var(--pain); text-decoration: underline wavy var(--pain); text-underline-offset: 3px; }
.du-okline { margin: 0; font-family: var(--f-code); font-size: .7rem; color: var(--good); }
.du-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.du-actions:empty { display: none; }
.du-read { margin: 0; font-size: .85rem; color: var(--ink-2); }
.du-out { margin: 0; font-size: .88rem; }
.du-card.bad .du-out b { color: var(--pain); }
.du-card.good .du-out b { color: var(--good); }
.du-challenges ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 3px; font-size: .95rem; }
.du-challenges li.done { color: var(--good); }
@media (prefers-reduced-motion: reduce) { .du-card { transition: none; } }
`;
