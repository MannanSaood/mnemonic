"use client";
import type { ReactNode } from "react";
import { PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, CHECK, CHECKS, PAYLOAD, PAYLOADS, PREDICT_ANSWER, analyse, correct, init, run, step, tally,
  type Action, type CheckId, type Outcome, type PayloadId, type Point, type Predict, type Row, type State,
} from "./model";

const OUT: Record<Outcome["kind"], string> = { rejected: "400", ignored: "200", emailed: "emailed", wrongEmail: "wrong email", crash: "crash · 500" };

function Line({ code, row, indent = 1, onPath, endsHere, outcome, children }: {
  code: string; row?: Row; indent?: number; onPath: boolean; endsHere: boolean; outcome?: Outcome; children?: ReactNode;
}) {
  return (
    <li className={"nar-line" + (onPath ? " path" : "") + (row?.error ? " err" : "")}>
      <div className="nar-code" style={{ paddingLeft: `${indent * 1.2}em` }}>
        <code>{code}</code>
        {children}
      </div>
      {row && row.type && <span className="nar-type" title="The type the compiler believes after this line">body: <b>{row.type}</b></span>}
      {row?.error && <span className="nar-error">error: {row.error}</span>}
      {endsHere && outcome && <span className={"nar-end " + outcome.kind}>{OUT[outcome.kind]}</span>}
    </li>
  );
}

function Slot({ c, st, dispatch, row, path, out }: { c: CheckId; st: State; dispatch: (a: Action) => void; row?: Row; path: Point[]; out: Outcome }) {
  const on = st.checks.includes(c);
  if (!on)
    return (
      <li className="nar-slot">
        <button className="nar-add" onClick={() => dispatch({ type: "toggle", check: c })} title={CHECK[c].what}>
          + add a {CHECK[c].label} check
        </button>
      </li>
    );
  return (
    <Line code={CHECK[c].code} row={row} indent={c === "instanceof" ? 2 : 1} onPath={path.includes(c)} endsHere={out.at === c} outcome={out}>
      <button className="nar-x" aria-label={`Remove the ${CHECK[c].label} check`} onClick={() => dispatch({ type: "toggle", check: c })}>×</button>
    </Line>
  );
}

function Handler({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const rows = analyse(st);
  const row = (p: Point) => rows.find((r) => r.point === p);
  const { path, outcome } = run(st, st.payload);
  const slot = (c: CheckId) => <Slot key={c} c={c} st={st} dispatch={dispatch} row={row(c)} path={path} out={outcome} />;
  return (
    <ol className="nar-flow" aria-label="The webhook handler, one statement per row">
      <li className="nar-line plain"><div className="nar-code"><code>{"async function handleWebhook(req: Request): Promise<Response> {"}</code></div></li>
      <Line code="let body: unknown;" onPath row={{ point: "parse", type: "unknown", error: null }} endsHere={false} />
      <Line code="try { body = await req.json(); } catch (err) {" onPath endsHere={outcome.at === "parse"} outcome={outcome} />
      {slot("instanceof")}
      {!st.checks.includes("instanceof")
        ? <Line code="return badRequest(err.message);" indent={2} row={{ point: "parse", type: "", error: row("parse")!.error }} onPath={st.payload === "broken"} endsHere={false} />
        : <Line code="throw err;" indent={2} onPath={false} endsHere={false} />}
      <Line code="}" onPath endsHere={false} />
      {(["typeof", "in", "guard", "equality", "null"] as CheckId[]).map(slot)}
      {st.hook && <Line code="plugins.forEach((p) => p.beforeEmail(body));" row={row("hook")} onPath={path.includes("hook")} endsHere={false} />}
      {st.hook && (st.recheck
        ? <Line code="if (body.data.customer === null) return ok(); // again" row={row("recheck")} onPath={path.includes("recheck")} endsHere={outcome.at === "recheck"} outcome={outcome} />
        : null)}
      <Line code="await mailer.paymentFailed(body.data.customer.email, body.data.failureCode);" row={row("use")} onPath={path.includes("use")} endsHere={outcome.at === "use"} outcome={outcome} />
      <li className="nar-line plain"><div className="nar-code"><code>{"  return ok();\n}"}</code></div></li>
    </ol>
  );
}

function Runs({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  return (
    <div className="nar-runs" role="group" aria-label="Payloads">
      {PAYLOADS.map((id) => {
        const o = run(st, id).outcome;
        const good = correct(st, id, o);
        return (
          <button key={id} className={"nar-run " + (good ? "good" : "bad")} aria-pressed={st.payload === id}
            onClick={() => dispatch({ type: "payload", id })}>
            <span>{PAYLOAD[id].label}</span>
            <b>{OUT[o.kind]}</b>
          </button>
        );
      })}
    </div>
  );
}

function Result({ st }: { st: State }) {
  const t = tally(st);
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  let take: string;
  if (t.errors > 0 && t.crashes > 0) take = "Every error the compiler shows is a line where it cannot prove what body is. The crashes below are the same lines, run as plain JavaScript.";
  else if (t.errors > 0) take = "Each check you add tells the compiler a little more. It needs the guard to reach PaymentEvent, the equality test to reach PaymentFailed, and the null check before .email.";
  else if (t.crashes > 0 && st.hook && !st.recheck) take = "Zero errors, and still a crash. The plugin set customer to null inside a callback after your null check. The compiler assumes calls do not undo a narrowing, so it kept believing Customer. Check again after code you do not control, or make the event readonly so plugins cannot write to it.";
  else if (t.crashes > 0 && st.guardLies) take = "Zero errors, and still a crash. The guard's signature says x is PaymentEvent, its body checks only type, and the compiler trusts the signature. A type predicate is a promise you write, not one the compiler verifies.";
  else if (t.crashes > 0 || t.wrongEmails > 0) take = "The compiler is satisfied, yet some payloads go wrong. Look at which checks are missing on their path.";
  else take = "The checks you wrote are the type. Each one removes the values that cannot reach the next line, and the compiler follows along. It only stops following where something it cannot see, a callback or a lying guard, changes the value.";
  return (
    <div className="pg-result">
      <span className="label">Where your handler stands</span>
      <p>
        {n(st.checks.length, "check")} added. The compiler reports {n(t.errors, "error")}. Of the seven payloads, {t.correct} end correctly,
        {" "}{n(t.crashes, "crash", "crashes")} with a 500 that the provider will retry, and {n(t.wrongEmails, "customer")} {t.wrongEmails === 1 ? "gets" : "get"} a wrong email.
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function NarrowingPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const t = tally(st);
  const o = run(st, st.payload).outcome;

  return (
    <PgFrame title="Narrow a webhook body" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p>A payment provider posts JSON to this handler. <code>req.json()</code> returns a value the compiler knows nothing about, so <code>body</code> starts as <code>unknown</code>. The last line emails the customer when a payment fails.</p>
        <p className="pg-rule"><b>Add checks in the gaps. Each row shows the type of body the compiler believes after it.</b></p>
      </div>

      <PgPredict<Predict>
        question="Once the handler compiles, install a plugin that runs after the null check and can set customer to null. What does the compiler say about the email line?"
        options={[
          { value: "flags", label: "It flags customer as possibly null" },
          { value: "silent", label: "Nothing: it still believes Customer" },
          { value: "refuses", label: "It refuses the plugin call" },
        ]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.hook}
        answer={PREDICT_ANSWER}
        explain={<>The compiler keeps a narrowing across function calls. Resetting it after every call would make ordinary code unusable, so the TypeScript team chose to be optimistic and accept that a callback can change a property behind its back. Pick the erased customer&apos;s payload to watch it crash.</>}
      />

      <div className="nar-wrap"><Handler st={st} dispatch={dispatch} /></div>

      {st.hook && (
        <pre className="nar-plugin"><code>{`// plugins/gdpr.ts, written by another team
export const gdpr = {
  beforeEmail(e: PaymentEvent) {
    if (erasureRequests.has(e.data.customer?.id)) e.data.customer = null;
  },
};`}</code></pre>
      )}

      <div className="nar-break">
        <span className="label">Break it</span>
        <PgChoice label="Plugin hook" value={st.hook ? "on" : "off"}
          options={[{ value: "off", label: "No plugins" }, { value: "on", label: "Install the GDPR plugin hook" }]}
          onChange={(v) => dispatch({ type: "hook", on: v === "on" })} />
        {st.hook && (
          <PgChoice label="After the plugins" value={st.recheck ? "on" : "off"}
            options={[{ value: "off", label: "Trust the earlier null check" }, { value: "on", label: "Check customer again" }]}
            onChange={(v) => dispatch({ type: "recheck", on: v === "on" })} />
        )}
        <PgChoice label="The guard's body" value={st.guardLies ? "on" : "off"}
          options={[{ value: "off", label: "isPaymentEvent checks the whole shape" }, { value: "on", label: "It only checks typeof type" }]}
          onChange={(v) => dispatch({ type: "guardLies", on: v === "on" })} />
      </div>

      <span className="label">Seven payloads through the same handler (types erased at runtime). Click one to trace it.</span>
      <Runs st={st} dispatch={dispatch} />
      <div className={"pg-entry " + (correct(st, st.payload, o) ? "ok" : "fail")} aria-live="polite">
        <span className="label">{PAYLOAD[st.payload].label}</span>
        <p><code className="nar-json">{PAYLOAD[st.payload].json}</code></p>
        <p>{o.text}</p>
      </div>

      <dl className="pg-stats">
        <div className={t.errors ? "bad" : ""}><dt>Compile errors</dt><dd>{t.errors}</dd></div>
        <div className={t.crashes ? "bad" : ""}><dt>Crashes</dt><dd>{t.crashes}</dd></div>
        <div className={t.wrongEmails ? "bad" : ""}><dt>Wrong emails</dt><dd>{t.wrongEmails}</dd></div>
        <div><dt>Correct</dt><dd>{t.correct}/{PAYLOADS.length}</dd></div>
      </dl>

      <Result st={st} />

      <div className="nar-challenges">
        <span className="label">Challenges</span>
        <ul>
          {CHALLENGES.map((c) => <li key={c.id} className={st.done.includes(c.id) ? "done" : ""}>{st.done.includes(c.id) ? "✓ " : "○ "}{c.text}</li>)}
        </ul>
      </div>

      <PgSources links={[
        { title: "the TypeScript Handbook on narrowing", href: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html" },
        { title: "Trade-offs in Control Flow Analysis (TypeScript issue 9998)", href: "https://github.com/microsoft/TypeScript/issues/9998" },
        { title: "the TypeScript Playground's type hovers", href: "https://www.typescriptlang.org/play" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.nar-wrap { border: 1px solid var(--line); background: var(--bg); overflow-x: auto; }
.nar-flow { list-style: none; margin: 0; padding: 6px 0; display: grid; gap: 2px; min-width: 300px; }
.nar-line { display: grid; gap: 2px; padding: 3px 10px 3px 12px; border-left: 3px solid transparent; transition: border-color .2s var(--ease), background .2s var(--ease); }
.nar-line.path { border-left-color: var(--accent); }
.nar-line.err { background: var(--pain-bg); }
.nar-code { display: flex; gap: 8px; align-items: baseline; }
.nar-code code { font-size: .78rem; white-space: pre-wrap; word-break: break-word; }
.nar-type { font-family: var(--f-code); font-size: .7rem; color: var(--ink-2); padding-left: 1.2em; }
.nar-type b { color: var(--accent); font-weight: 600; }
.nar-error { font-family: var(--f-code); font-size: .7rem; color: var(--pain); padding-left: 1.2em; text-decoration: underline wavy var(--pain); text-underline-offset: 3px; }
.nar-end { justify-self: start; margin-left: 1.2em; font-family: var(--f-code); font-size: .66rem; letter-spacing: .06em; text-transform: uppercase; padding: 1px 6px; border: 1px solid var(--line); }
.nar-end.rejected, .nar-end.ignored, .nar-end.emailed { color: var(--good); border-color: var(--good); background: var(--good-bg); }
.nar-end.crash, .nar-end.wrongEmail { color: var(--pain); border-color: var(--pain); background: var(--pain-bg); font-weight: 700; }
.nar-slot { padding: 1px 10px 1px 1.4em; }
.nar-add { width: 100%; text-align: left; border: 1px dashed var(--line); background: transparent; color: var(--ink-2); font-family: var(--f-code); font-size: .72rem; padding: 3px 8px; cursor: pointer; }
.nar-add:hover, .nar-add:focus-visible { border-color: var(--accent); color: var(--accent); }
.nar-x { border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); font-size: .75rem; line-height: 1; padding: 1px 5px; cursor: pointer; }
.nar-plugin { margin: 0; border: 1px solid var(--pain); background: var(--surface); padding: 8px 10px; font-size: .74rem; overflow-x: auto; }
.nar-break { display: grid; gap: 6px; border: 1px solid var(--line); background: var(--bg); padding: 10px 12px; }
.nar-break .pg-choice { flex-wrap: wrap; }
.nar-runs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px; }
.nar-run { display: grid; gap: 2px; text-align: left; border: 1px solid var(--line); background: var(--surface); padding: 5px 8px; font-size: .8rem; cursor: pointer; color: var(--ink); }
.nar-run b { font-family: var(--f-code); font-size: .68rem; letter-spacing: .05em; text-transform: uppercase; }
.nar-run.good b { color: var(--good); }
.nar-run.bad { border-color: var(--pain); }
.nar-run.bad b { color: var(--pain); }
.nar-run[aria-pressed="true"] { outline: 2px solid var(--accent); outline-offset: 1px; }
.nar-json { font-size: .72rem; word-break: break-all; }
.nar-challenges ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 3px; font-size: .95rem; }
.nar-challenges li.done { color: var(--good); }
@media (prefers-reduced-motion: reduce) { .nar-line { transition: none; } }
`;
