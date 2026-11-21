"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ARCHIVE_FIX, BACKEND, BACKENDS, CALLER, CALLERS, CLAUSE, PREDICT_ANSWER, challenges, init, run, step, tally,
  type Action, type ArchiveFix, type Backend, type Clause, type Predict, type Run, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const GLYPH: Record<Run["status"], string> = { pass: "✓ works", fail: "✗ breaks", handled: "– does nothing", rejected: "build error" };

function TypeCheck({ st, b }: { st: State; b: Backend }) {
  if (b === "archive" && st.archiveFix === "split") return <span className="lsp-tc">BlobReader only</span>;
  return <span className="lsp-tc">implements BlobStore ✓</span>;
}

function Matrix({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  return (
    <div className="lsp-wrap">
      <table className="lsp-matrix">
        <caption className="label">Every caller against every backend</caption>
        <thead>
          <tr>
            <th scope="col">Backend</th>
            {CALLERS.map((c) => <th key={c} scope="col" title={CALLER[c].what}>{CALLER[c].name}</th>)}
          </tr>
        </thead>
        <tbody>
          {BACKENDS.map((b) => {
            const shown = st.revealed.includes(b);
            return (
              <tr key={b}>
                <th scope="row">
                  <span className="lsp-bname">{BACKEND[b].name}</span>
                  <TypeCheck st={st} b={b} />
                  {!shown && <PgButton onClick={() => dispatch({ type: "plug", backend: b })}>Plug in</PgButton>}
                </th>
                {CALLERS.map((c) => {
                  const r = run(st, b, c);
                  const sel = st.selected?.backend === b && st.selected.caller === c;
                  return (
                    <td key={c}>
                      <button className={"lsp-cell" + (shown ? ` ${r.status}` : " hidden") + (sel ? " sel" : "")}
                        aria-pressed={sel}
                        aria-label={`${BACKEND[b].name} in ${CALLER[c].name}: ${shown ? GLYPH[r.status] : "not run yet"}`}
                        onClick={() => dispatch({ type: "inspect", backend: b, caller: c })}>
                        {shown ? GLYPH[r.status] : "run"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Contract({ broke }: { broke: Clause | null }) {
  return (
    <div className="lsp-contract">
      <span className="label">The BlobStore contract the callers rely on</span>
      <ul>
        {(Object.keys(CLAUSE) as Clause[]).map((k) => (
          <li key={k} className={broke === k ? "broke" : ""}>
            {CLAUSE[k].text} <small>{CLAUSE[k].rule}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Trace({ r }: { r: Run | null }) {
  if (!r) return <p className="pg-empty">Click a cell to see that caller run against that backend, call by call.</p>;
  return (
    <div className={"pg-entry" + (r.status === "pass" || r.status === "rejected" ? " ok" : " fail")} aria-live="polite">
      <span className="label">{CALLER[r.caller].name} on {BACKEND[r.backend].name}</span>
      <ol className="lsp-steps">
        {r.steps.map((x, i) => <li key={i} className={x.ok ? "" : "bad"}><code>{x.call}</code> → {x.result}</li>)}
      </ol>
      <p>{r.explain}</p>
    </div>
  );
}

/** Runs for the backends the reader has plugged in so far. */
const seen = (st: State) => BACKENDS.filter((b) => st.revealed.includes(b)).flatMap((b) => CALLERS.map((c) => run(st, b, c)));
const count = (rs: Run[], s: Run["status"]) => rs.filter((r) => r.status === s).length;

function Result({ st }: { st: State }) {
  const t = tally(st);
  const rs = seen(st);
  const fails = count(rs, "fail"), noops = count(rs, "handled"), refused = count(rs, "rejected");
  const all = st.revealed.length === BACKENDS.length;
  if (st.revealed.length < 2) return null;
  let take: string;
  const archiveRun = st.revealed.includes("archive");
  if (archiveRun && t.namesConcrete > 0)
    take = "The crashes are gone, but every caller that writes now knows ArchiveStore exists and silently skips its job. Substitution failed, so the callers had to start asking what they were given.";
  else if (noops > 0)
    take = "Weakening the contract made the error legal. The feature still does not work, and every caller now handles a failure that S3 never produces.";
  else if (fails > 0 && archiveRun && st.archiveFix === "split")
    take = "The archive is honest now. It only claims to be a reader, and the compiler keeps it out of writers. Fix the remaining backends inside the backends, so they keep the promises the contract makes.";
  else if (fails > 0)
    take = "Every backend compiled, and still some callers broke. The type checker checks names and signatures. It cannot check what a method promises, and that promise is what a caller relies on.";
  else if (!all)
    take = "No breaks among the backends you have run so far. Plug in the rest.";
  else
    take = "Every pair either works or is refused at build time, and no caller names a backend. Each backend now promises only what it can keep, and that is what makes it substitutable.";
  return (
    <div className="pg-result">
      <span className="label">Where your design stands</span>
      <p>
        {all ? "All four backends type-check. " : `${n(st.revealed.length, "backend")} plugged in, all of them type-check. `}
        Of the {rs.length} caller/backend pairs you ran, {fails} break in production, {noops} silently do nothing and {refused} are refused at build time.
        Callers that name a concrete backend: {t.namesConcrete}. Callers you edited: {t.callersEdited}.
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function LiskovPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const sel = st.selected ? run(st, st.selected.backend, st.selected.caller) : null;
  const t = tally(st);
  const rs = seen(st);
  const visibleFailures = count(rs, "fail"), noops = count(rs, "handled"), refused = count(rs, "rejected");

  return (
    <PgFrame title="Plug every backend into every caller" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p>Four callers were written and tested against <code>S3Store</code> through a <code>BlobStore</code> interface. Three new backends implement the same interface, and all of them compile.</p>
        <p className="pg-rule"><b>Plug each backend in where S3 was, then click any cell to read the trace.</b></p>
      </div>

      <PgPredict<Predict>
        question="ArchiveStore compiles against BlobStore. Plug it in where S3 was. Which callers break?"
        options={[
          { value: "none", label: "None: it type-checks" },
          { value: "writers", label: "The ones that write" },
          { value: "all", label: "All four" },
        ]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.revealed.includes("archive")}
        answer={PREDICT_ANSWER}
        explain={<>Upload, Thumbnailer and Retention break; the monthly report, which only reads, works perfectly. Substitutability depends on what the caller relies on, which is why Liskov&apos;s definition quantifies over all programs that use the type.</>}
      />

      <Matrix st={st} dispatch={dispatch} />

      <div className="pg-grid">
        <Contract broke={sel?.broke ?? null} />
        <Trace r={sel} />
      </div>

      <div className="lsp-fixes">
        <span className="label">Fixes</span>
        <div className="lsp-fix">
          <span>ArchiveStore</span>
          <PgChoice<ArchiveFix> label="Fix for ArchiveStore" value={st.archiveFix}
            options={(Object.keys(ARCHIVE_FIX) as ArchiveFix[]).map((k) => ({ value: k, label: ARCHIVE_FIX[k].label, note: ARCHIVE_FIX[k].what }))}
            onChange={(v) => dispatch({ type: "archiveFix", fix: v })} />
          <p className="muted">{ARCHIVE_FIX[st.archiveFix].what}</p>
        </div>
        <div className="lsp-fix">
          <span>ReplicaStore</span>
          <PgChoice label="Fix for ReplicaStore" value={st.replicaFixed ? "on" : "off"}
            options={[{ value: "off", label: "Read from replica" }, { value: "on", label: "Read your own writes from the primary" }]}
            onChange={(v) => dispatch({ type: "fixReplica", on: v === "on" })} />
        </div>
        <div className="lsp-fix">
          <span>NfsStore</span>
          <PgChoice label="Fix for NfsStore" value={st.nfsFixed ? "on" : "off"}
            options={[{ value: "off", label: "Reject long keys" }, { value: "on", label: "Hash keys over 64 characters" }]}
            onChange={(v) => dispatch({ type: "fixNfs", on: v === "on" })} />
        </div>
      </div>

      <dl className="pg-stats">
        <div className={visibleFailures ? "bad" : ""}><dt>Breaks in production</dt><dd>{visibleFailures}</dd></div>
        <div className={noops ? "bad" : ""}><dt>Silent no-ops</dt><dd>{noops}</dd></div>
        <div><dt>Caught at build</dt><dd>{refused}</dd></div>
        <div className={t.namesConcrete ? "bad" : ""}><dt>Callers naming a backend</dt><dd>{t.namesConcrete}</dd></div>
      </dl>

      <Result st={st} />

      <div className="lsp-challenges">
        <span className="label">Challenges</span>
        <ul>
          {challenges(st).map((c) => <li key={c.id} className={c.done ? "done" : ""}>{c.done ? "✓ " : "○ "}{c.text}</li>)}
        </ul>
      </div>

      <PgSources links={[
        { title: "Liskov and Wing, A Behavioral Notion of Subtyping (1994)", href: "https://www.cs.columbia.edu/~wing/publications/LiskovWing94.pdf" },
        { title: "the Liskov substitution principle on Wikipedia", href: "https://en.wikipedia.org/wiki/Liskov_substitution_principle" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.lsp-wrap { overflow-x: auto; }
.lsp-matrix { border-collapse: collapse; width: 100%; min-width: 520px; font-size: .85rem; }
.lsp-matrix caption { text-align: left; padding-bottom: 6px; }
.lsp-matrix th, .lsp-matrix td { border: 1px solid var(--line); padding: 4px; text-align: left; vertical-align: top; }
.lsp-matrix thead th { font-family: var(--f-code); font-size: .64rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); background: var(--surface-2); font-weight: 500; }
.lsp-matrix tbody th { background: var(--surface); font-weight: 400; display: grid; gap: 3px; justify-items: start; border-width: 0 0 1px 0; }
.lsp-bname { font-family: var(--f-code); font-size: .78rem; font-weight: 600; }
.lsp-tc { font-size: .72rem; color: var(--good); }
.lsp-cell { width: 100%; min-height: 34px; border: 1px solid var(--line); background: var(--surface); font-family: var(--f-code); font-size: .72rem; color: var(--ink); transition: background .2s var(--ease); }
.lsp-cell.pass { background: var(--good-bg); color: var(--good); }
.lsp-cell.fail { background: var(--pain-bg); color: var(--pain); font-weight: 600; }
.lsp-cell.handled { background: var(--surface-2); color: var(--ink-2); }
.lsp-cell.rejected { background: var(--bg); color: var(--accent); border-style: dashed; border-color: var(--accent); }
.lsp-cell.hidden { color: var(--ink-2); }
.lsp-cell.sel { outline: 2px solid var(--accent); outline-offset: 1px; }
.lsp-contract { border: 1px solid var(--line); background: var(--bg); padding: 10px 12px; display: grid; gap: 6px; align-content: start; }
.lsp-contract ul { margin: 0; padding-left: 1.1em; display: grid; gap: 4px; font-size: .92rem; }
.lsp-contract small { display: block; font-family: var(--f-code); font-size: .62rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.lsp-contract li.broke { color: var(--pain); font-weight: 600; }
.lsp-steps { margin: 4px 0; padding-left: 1.3em; display: grid; gap: 2px; font-size: .85rem; }
.lsp-steps code { font-size: .74rem; }
.lsp-steps li.bad { color: var(--pain); }
.lsp-fixes { display: grid; gap: 8px; border: 1px solid var(--line); background: var(--bg); padding: 10px 12px; }
.lsp-fix { display: grid; gap: 4px; }
.lsp-fix > span { font-family: var(--f-code); font-size: .74rem; font-weight: 600; }
.lsp-fix p { margin: 0; font-size: .88rem; }
.lsp-challenges ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 3px; font-size: .95rem; }
.lsp-challenges li.done { color: var(--good); }
@media (prefers-reduced-motion: reduce) { .lsp-cell { transition: none; } }
`;
