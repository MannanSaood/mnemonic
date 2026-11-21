"use client";
import { Fragment } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ANSWER, BODY, CHALLENGES, DROP_MAX, DROP_MIN, KEY_ROW, ROWS, SIG_CODE, USE_ROWS, allowed, cfgRegion, headRegion, init, keyRegion, outcome, revealed, stats, step, verdict,
  type Action, type Guess, type Region, type Sig, type State, type Verdict,
} from "./model";

const CSS = `
.lifetimes-sig { margin: 0; padding: 6px 8px; border: 1px solid var(--line); background: var(--surface); font-family: var(--f-code); font-size: .76rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.lifetimes-sig .bad { color: var(--pain); font-weight: 700; text-decoration: underline wavy var(--pain); text-underline-offset: 3px; }
.lifetimes-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--surface); }
.lifetimes-grid { border-collapse: collapse; width: 100%; min-width: 520px; font-size: .8rem; }
.lifetimes-grid th, .lifetimes-grid td { border-bottom: 1px solid var(--line); padding: 2px 4px; vertical-align: middle; }
.lifetimes-grid th { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 600; text-align: center; background: var(--bg); }
.lifetimes-ln { font-family: var(--f-code); color: var(--ink-2); text-align: right; width: 2em; }
.lifetimes-code { font-family: var(--f-code); white-space: pre; font-size: .76rem; }
.lifetimes-code.unused { color: var(--ink-2); text-decoration: line-through; }
tr.lifetimes-droprow td { background: var(--bg); }
tr.lifetimes-droprow .lifetimes-code { color: var(--ink); font-weight: 700; }
tr.bad .lifetimes-code, tr.bad .lifetimes-ln { color: var(--pain); font-weight: 700; }
tr.bad { background: var(--pain-bg); }
.lifetimes-bar { width: 3.2em; padding: 0 !important; }
.lifetimes-bar > * { display: block; min-height: 1.9em; width: 100%; }
.lifetimes-bar .on { background: var(--hl); }
.lifetimes-bar .on.cfg { background: var(--surface-2); }
.lifetimes-bar .on.region { background: var(--accent); opacity: .45; }
.lifetimes-bar .on.key { background: var(--accent); }
.lifetimes-bar .on.key.out { background: var(--pain); }
.lifetimes-bar .freed { background: repeating-linear-gradient(135deg, transparent 0 4px, var(--line) 4px 5px); }
.lifetimes-bar button { border: 0; background: transparent; cursor: pointer; font-family: var(--f-code); font-size: .66rem; color: var(--ink-2); padding: 0; }
.lifetimes-bar button.on.key { color: var(--bg); }
.lifetimes-drop .pg-btn { font-family: var(--f-code); font-size: .64rem; padding: 1px 5px; white-space: nowrap; }
.lifetimes-verdict { margin: 0; padding: 8px; border: 1px solid var(--pain); background: var(--pain-bg); font-family: var(--f-code); font-size: .74rem; white-space: pre-wrap; }
.lifetimes-verdict b { color: var(--pain); }
.lifetimes-ok { margin: 0; padding: 8px; border: 1px solid var(--good); background: var(--good-bg); color: var(--good); font-family: var(--f-code); font-size: .8rem; font-weight: 600; }
.lifetimes-run { border: 1px dashed var(--pain); background: var(--bg); padding: 8px; display: grid; gap: 4px; }
.lifetimes-run.luck, .lifetimes-run.fine { border-color: var(--good); }
.lifetimes-run p { margin: 0; font-size: .88rem; }
.lifetimes-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.lifetimes-goals li { font-size: .9rem; padding-left: 1.6em; position: relative; }
.lifetimes-goals li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.lifetimes-goals li.met::before { content: "✓"; color: var(--good); font-weight: 700; }
.lifetimes-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: .78rem; color: var(--ink-2); margin: 0; }
.lifetimes-legend i { display: inline-block; width: 1.2em; height: .8em; vertical-align: middle; margin-right: 4px; border: 1px solid var(--line); }
`;

const SIG_LABEL: Record<Sig, string> = { both: "one 'a for both", elided: "no annotations", fallback: "tied to default_tenant", owned: "returns String" };
const inR = (r: Region | null, n: number) => !!r && n >= r.from && n <= r.to;

function Signature({ st, v }: { st: State; v: Verdict }) {
  const body = st.sig === "owned" ? `${BODY}.to_owned()` : BODY;
  return (
    <pre className="lifetimes-sig" aria-label="The function's signature and body">
      <span className={v.at === "sig" ? "bad" : ""}>{SIG_CODE[st.sig]}</span>{" {\n    "}
      <span className={v.at === "body" ? "bad" : ""}>{body}</span>{"\n}"}
    </pre>
  );
}

function Timeline({ st, v, dispatch }: { st: State; v: Verdict; dispatch: (a: Action) => void }) {
  const head = headRegion(st);
  const keyR = keyRegion(st);
  const a = allowed(st);
  const badRows = new Set(v.notes.map((n) => n.at).filter((x): x is number => typeof x === "number"));
  const regionName = st.sig === "fallback" ? "'b" : "'a";
  const keyType = st.sig === "owned" ? "String" : "&str";
  const row = (n: number) => {
    const usesKey = USE_ROWS.includes(n);
    const unused = usesKey && n > st.lastUse;
    const keyOn = inR(keyR, n);
    const out = keyOn && st.sig !== "owned" && a !== null && !inR(a, n);
    const outBoth = keyOn && st.sig === "both" && n > st.drop;
    return (
      <tr key={n} className={badRows.has(n) && n !== st.drop ? "bad" : ""}>
        <td className="lifetimes-ln">{n}</td>
        <td className={"lifetimes-code" + (unused ? " unused" : "")} title={unused ? "key is no longer used here" : undefined}>{ROWS[n - 1]}</td>
        <td className="lifetimes-bar"><span className={inR(cfgRegion, n) ? "on cfg" : ""} /></td>
        <td className="lifetimes-bar"><span className={inR(head, n) ? "on" : n > st.drop ? "freed" : ""} /></td>
        {st.sig !== "owned" && st.sig !== "elided" && <td className="lifetimes-bar"><span className={inR(a, n) ? "on region" : ""} /></td>}
        <td className="lifetimes-bar">
          {usesKey ? (
            <button className={keyOn ? "on key" + (out || outBoth ? " out" : "") : ""} onClick={() => dispatch({ type: "lastUse", row: n })}
              aria-pressed={n === st.lastUse} aria-label={`Make line ${n} the last use of key`} title={`Last use of key: line ${n}`}>
              {n === st.lastUse ? "last" : keyOn ? "use" : "+"}
            </button>
          ) : <span className={keyOn ? "on key" : ""} />}
        </td>
        <td className="lifetimes-drop">
          {n >= DROP_MIN && n <= DROP_MAX && n !== st.drop && (
            <PgButton onClick={() => dispatch({ type: "drop", row: n })} title={`Move drop(head) to just after line ${n}`}>drop here</PgButton>
          )}
        </td>
      </tr>
    );
  };
  return (
    <div className="lifetimes-wrap">
      <table className="lifetimes-grid" aria-label="Timeline of serve">
        <thead>
          <tr>
            <th>#</th><th style={{ textAlign: "left" }}>async fn serve(..)</th><th>config</th><th>head</th>
            {st.sig !== "owned" && st.sig !== "elided" && <th>{regionName}</th>}
            <th>key: {keyType}</th><th>move</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((_, i) => (
            <Fragment key={i}>
              {row(i + 1)}
              {i + 1 === st.drop && (
                <tr className={"lifetimes-droprow" + (v.at === st.drop ? " bad" : "")}>
                  <td className="lifetimes-ln">↳</td>
                  <td className="lifetimes-code">drop(head); // free the 16 KiB now</td>
                  <td className="lifetimes-bar"><span className="on cfg" /></td>
                  <td className="lifetimes-bar"><span className="freed" /></td>
                  {st.sig !== "owned" && st.sig !== "elided" && <td className="lifetimes-bar"><span className={inR(a, st.drop + 0.5) ? "on region" : ""} /></td>}
                  <td className="lifetimes-bar"><span className={st.lastUse > st.drop ? "on key" + (st.sig === "owned" ? "" : " out") : ""} /></td>
                  <td />
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VerdictBox({ v, st }: { v: Verdict; st: State }) {
  if (v.ok) return <p className="lifetimes-ok" role="status">Compiles.{st.sig === "owned" ? " key owns a copy of its bytes, so it does not care when head is dropped." : ` Every use of key lies inside ${st.sig === "fallback" ? "'b" : "'a"}.`}</p>;
  const where = (at: number | "sig" | "body") => (at === "sig" ? "signature" : at === "body" ? "body" : `line ${at}`);
  return (
    <pre className="lifetimes-verdict" role="status" aria-live="polite">
      <b>error{v.code && v.code !== "lifetime" ? `[${v.code}]` : ""}: {v.message}</b>{"\n"}
      {v.notes.map((n) => `  ${where(n.at)}: ${n.text}\n`).join("")}
    </pre>
  );
}

function Runtime({ st }: { st: State }) {
  const o = outcome(st);
  return (
    <div className={"lifetimes-run " + o.kind} aria-live="polite">
      <span className="label">Without the checker, on this request</span>
      <p>{o.text}</p>
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
        You tried {m.tried} layouts. The compiler rejected {m.rejected} and accepted {m.accepted}. On a request with an
        X-Tenant header, {m.dangles} of the rejected ones would have read freed memory. On a request without one, the
        same code would have run fine, so a test suite that never sends the header would never have seen it.
      </p>
      <p className="pg-takeaway">
        No signature made head live longer. The compiler only checked key&apos;s uses against the region the signature
        promised, the shorter of head and the config. Every accepted layout either kept key&apos;s uses before
        drop(head) or stopped borrowing and paid for a small copy.
      </p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "yes", label: "Yes: the result points at the config" },
  { value: "no", label: "No: the result might point into head" },
  { value: "warn", label: "It compiles with a warning" },
];

export default function Lifetimes() {
  const { state: st, dispatch } = useModel(step, init);
  const v = verdict(st);
  return (
    <PgFrame title="Regions on a timeline" onReset={() => dispatch({ type: "reset" })}
      toolbar={<PgButton onClick={() => dispatch({ type: "unchecked", on: !st.unchecked })} title="Show what this layout does at runtime if nothing checked it">{st.unchecked ? "Hide the unchecked run" : "Run without the checker"}</PgButton>}>
      <style>{CSS}</style>
      <p className="pg-rule">
        serve reads a 16 KiB request head, asks tenant_key for the tenant, and drops the head early to free memory.
        Each column is how long something is valid. <b>Move drop(head) and key&apos;s last use, switch the signature,
        and watch where key leaves its region.</b>
      </p>

      <PgPredict<Guess>
        question="drop(head) runs after line 4, and key is used until line 7. This request has no X-Tenant header, so tenant_key returns the config default, which lives all along. Does it compile?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed(st)}
        answer={ANSWER}
        explain="The signature says the result borrows from head or default_tenant, so key is only valid in 'a, where both are alive. That ends at drop(head). The compiler checks the call against the signature and never looks at which branch runs, because the next request may carry the header. Turn the header on and run it without the checker to see why."
      />

      <div className="pg-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="label">Signature</span>
        <PgChoice<Sig> label="Signature of tenant_key" value={st.sig} options={(["both", "elided", "fallback", "owned"] as Sig[]).map((s) => ({ value: s, label: SIG_LABEL[s] }))} onChange={(s) => dispatch({ type: "sig", sig: s })} />
      </div>
      <Signature st={st} v={v} />
      <div className="pg-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="label">This request</span>
        <PgChoice<"no" | "yes"> label="Does this request carry an X-Tenant header" value={st.header ? "yes" : "no"}
          options={[{ value: "no", label: "no X-Tenant header" }, { value: "yes", label: "X-Tenant: acme" }]}
          onChange={(x) => dispatch({ type: "header", on: x === "yes" })} />
        <span className="muted">At runtime key points {st.sig === "owned" ? "at its own copy" : st.header ? "into head" : "at the config default"}.</span>
      </div>

      <Timeline st={st} v={v} dispatch={dispatch} />
      <p className="lifetimes-legend">
        <span><i style={{ background: "var(--accent)" }} />key is used</span>
        <span><i style={{ background: "var(--accent)", opacity: 0.45 }} />region the signature allows</span>
        <span><i style={{ background: "var(--pain)" }} />used outside it</span>
        <span><i style={{ background: "repeating-linear-gradient(135deg, transparent 0 4px, var(--line) 4px 5px)" }} />head freed</span>
      </p>
      <VerdictBox v={v} st={st} />
      {st.unchecked && <Runtime st={st} />}

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Challenges</span>
          <ul className="lifetimes-goals" aria-label="Challenges">
            {CHALLENGES.map((c) => <li key={c.id} className={st.done.includes(c.id) ? "met" : ""}>{c.text}</li>)}
          </ul>
        </div>
        <div className="pg-card">
          <span className="label">This layout</span>
          <dl className="pg-stats">
            <div className={v.ok ? "" : "bad"}><dt>Compiles</dt><dd>{v.ok ? "yes" : "no"}</dd></div>
            <div><dt>head valid</dt><dd>lines 2-{st.drop}</dd></div>
            <div><dt>key used</dt><dd>lines {KEY_ROW}-{st.lastUse}</dd></div>
            <div><dt>Copies per request</dt><dd>{st.sig === "owned" ? 1 : 0}</dd></div>
          </dl>
        </div>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "The Rust Book, chapter 10.3 (the longest example)", href: "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html" },
        { title: "RustViz lifetime timelines", href: "https://arxiv.org/abs/2011.09012" },
        { title: "Aquascope (Brown University)", href: "https://cel.cs.brown.edu/aquascope/" },
      ]} />
    </PgFrame>
  );
}
