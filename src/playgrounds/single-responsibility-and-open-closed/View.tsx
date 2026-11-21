"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ACTOR, PREDICT_ANSWER, TICKETS, UNIT, baseline, files, init, ownersOf, replay, step,
  type Action, type Actor, type Predict, type State, type Tally, type Unit, type TicketResult,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const LETTER = "ABCDEFGHIJ";
const fileName = (i: number) => (i < 0 ? "new file" : `file ${LETTER[i] ?? i + 1}`);

function teamsIn(st: State, units: Unit[]): Actor[] {
  const set = new Set<Actor>();
  for (const u of units) for (const a of ownersOf(st, u)) set.add(a);
  return [...set];
}

function FileMap({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const fs = files(st);
  const sel = st.selected;
  return (
    <div className="srp-files">
      {fs.map((units, i) => {
        const teams = teamsIn(st, units);
        return (
          <div key={i} className={"srp-file" + (teams.length > 1 ? " mixed" : "") + (sel ? " target" : "")}>
            <button className="srp-drop" onClick={() => dispatch({ type: "move", file: i })} disabled={!sel}
              aria-label={sel ? `Move ${UNIT[sel].label} to ${fileName(i)}` : fileName(i)}>
              <span className="srp-fname">{fileName(i)}</span>
              <span className={"srp-teams" + (teams.length > 1 ? " bad" : "")}>{teams.map((t) => ACTOR[t]).join(" + ")}</span>
            </button>
            <div className="srp-units">
              {units.map((u) => (
                <button key={u} className={`srp-unit ${ownersOf(st, u).length > 1 ? "shared" : UNIT[u].owner}`}
                  aria-pressed={sel === u} title={UNIT[u].note}
                  onClick={() => dispatch({ type: "select", unit: u })}>
                  <code>{UNIT[u].label}</code>
                  <small>{ownersOf(st, u).map((a) => ACTOR[a]).join(" + ")}</small>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <button className={"srp-file srp-new" + (sel ? " target" : "")} disabled={!sel}
        onClick={() => dispatch({ type: "move", file: "new" })}>
        {sel ? `+ Move ${UNIT[sel].label} to a new file` : "Select a function, then a file"}
      </button>
    </div>
  );
}

function Row({ r }: { r: TicketResult }) {
  const t = r.ticket;
  const bad = r.conflict || r.surprise || r.pulled.length > 0;
  const where = r.files.map(fileName).join(" + ");
  const notes: string[] = [];
  if (r.files.includes(-1)) notes.push("A new rule file. No existing code was edited.");
  if (r.taxEdit) notes.push("Edited the tax switch that already works for every other country.");
  if (r.pulled.length) notes.push(`${r.pulled.map((a) => ACTOR[a]).join(" and ")} must review and retest: their code is in the same file.`);
  if (r.conflict) notes.push("Merge conflict: the other developer this sprint edited the same file.");
  if (r.surprise) notes.push("renderPdf() calls the same round2(). Brand's printed amounts changed and nobody on Brand asked for it.");
  if (!notes.length) notes.push(`Only ${ACTOR[t.actor]}'s own code changed.`);
  return (
    <div className={"pg-entry" + (bad ? " fail" : " ok")}>
      <div className="pg-path" aria-hidden="true">
        <span>sprint {t.sprint}</span><span>{ACTOR[t.actor]}</span><span>{where}</span><span>{bad ? "✗" : "✓"}</span>
      </div>
      <p><b>#{t.id} {t.title}.</b> {notes.join(" ")}</p>
    </div>
  );
}

function Stats({ t, base }: { t: Tally; base: Tally }) {
  const cell = (label: string, v: number, b: number) => (
    <div className={v > 0 ? "bad" : ""}><dt>{label}</dt><dd>{v} <small className="srp-was">one class: {b}</small></dd></div>
  );
  return (
    <dl className="pg-stats">
      {cell("Merge conflicts", t.conflicts, base.conflicts)}
      {cell("Teams pulled in", t.pulled, base.pulled)}
      {cell("Surprise changes", t.surprises, base.surprises)}
      {cell("Tax code edits", t.taxEdits, base.taxEdits)}
    </dl>
  );
}

function Takeaway({ t }: { t: Tally }) {
  if (t.fileCount === 1)
    return <>Every ticket from every team landed in one file. Two developers each sprint means every sprint ends in a merge, and every change needs the other two teams to retest. Move the functions so each file answers to one team, then replay.</>;
  if (t.surprises > 0)
    return <>The files are split, but Finance and Brand still share <code>round2()</code>. The two uses look the same today and change for different reasons. Give each team its own copy; that duplication is fine, because it is not really duplication.</>;
  if (t.scattered > 0)
    return <>No team collides with another, but {n(t.scattered, "ticket")} had to edit several files to make one change. A responsibility is a team&apos;s reason to change, not a single function. Put back together what one team always changes together.</>;
  if (t.pulled > 0 || t.conflicts > 0)
    return <>Some files still hold more than one team&apos;s code, so a change for one team drags in another. Group by who asks for the change.</>;
  if (t.taxEdits > 0)
    return <>Each team now owns its file. Finance&apos;s two new countries still edited the working tax switch, and in sprint 4 that collided with Finance&apos;s own discount ticket. Turn on tax rules as files.</>;
  return <>Each team changed only its own file, nobody was surprised, and both new countries arrived as new files without touching working code. That is the single responsibility principle and the open/closed principle working together.</>;
}

export default function SrpOcpPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const now = replay(st);
  const base = baseline();
  const shown = st.replays > 0;

  return (
    <PgFrame title="Six months of tickets against InvoiceService" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p>Three teams send tickets to the same invoice code: <b>Finance</b> (totals and tax), <b>Brand</b> (the PDF) and <b>Customer Ops</b> (the email). Each sprint, two developers work on two tickets at once.</p>
        <p className="pg-rule"><b>Arrange the functions into files, then replay the 8 tickets.</b> Click a function, then click the file it should live in.</p>
      </div>

      <PgPredict<Predict>
        question="Ticket 3: Finance changes how round2() rounds VAT. In the one-class design, whose output changes?"
        options={[
          { value: "finance", label: "Only Finance's totals" },
          { value: "both", label: "Finance's totals and Brand's PDFs" },
          { value: "none", label: "Nobody else's: it is one helper" },
        ]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={shown}
        answer={PREDICT_ANSWER}
        explain={<>renderPdf() calls the same round2() to print line amounts. One edit for Finance changed Brand&apos;s output. The two uses only looked like the same code. Martin calls this accidental duplication.</>}
      />

      <div className="srp-tools">
        <div className="pg-actions" role="group" aria-label="Layouts">
          <span className="label">Start from</span>
          <PgButton onClick={() => dispatch({ type: "preset", preset: "oneClass" })}>One class</PgButton>
          <PgButton onClick={() => dispatch({ type: "preset", preset: "byTeam" })}>One file per team</PgButton>
          <PgButton onClick={() => dispatch({ type: "preset", preset: "perFunction" })}>One file per function</PgButton>
        </div>
        <div className="srp-toggle">
          <span className="label">round2()</span>
          <PgChoice label="round2()" value={st.splitRound ? "split" : "shared"}
            options={[{ value: "shared", label: "Shared" }, { value: "split", label: "A copy per team" }]}
            onChange={(v) => dispatch({ type: "splitRound", on: v === "split" })} />
        </div>
        <div className="srp-toggle">
          <span className="label">Tax rules</span>
          <PgChoice label="Tax rules" value={st.plugins ? "files" : "switch"}
            options={[{ value: "switch", label: "One switch" }, { value: "files", label: "A file per rule" }]}
            onChange={(v) => dispatch({ type: "plugins", on: v === "files" })} />
        </div>
      </div>

      <FileMap st={st} dispatch={dispatch} />

      <div className="pg-actions">
        <PgButton primary onClick={() => dispatch({ type: "replay" })}>{shown ? "Replay again" : `Replay ${TICKETS.length} tickets`}</PgButton>
        {shown && <span className="muted">Results update as you move things.</span>}
      </div>

      {shown && (
        <>
          <Stats t={now.tally} base={base.tally} />
          <div className="pg-log" aria-live="polite">{now.results.map((r) => <Row key={r.ticket.id} r={r} />)}</div>
          <div className="pg-result">
            <span className="label">What your layout cost</span>
            <p>
              Your {n(now.tally.fileCount, "file")}: {n(now.tally.conflicts, "merge conflict")}, {n(now.tally.pulled, "review")} by a team that asked for nothing, {n(now.tally.surprises, "surprise change")}, {n(now.tally.taxEdits, "edit")} to working tax code.
              The one class: {base.tally.conflicts}, {base.tally.pulled}, {base.tally.surprises} and {base.tally.taxEdits}.
            </p>
            <p className="pg-takeaway"><Takeaway t={now.tally} /></p>
          </div>
        </>
      )}

      <PgSources links={[
        { title: "Robert C. Martin, The Single Responsibility Principle (2014)", href: "https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html" },
        { title: "CodeScene's change coupling maps", href: "https://codescene.io/docs/guides/technical/change-coupling.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.srp-tools { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
.srp-tools .pg-actions { align-items: center; }
.srp-toggle { display: flex; gap: 8px; align-items: center; }
.srp-files { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.srp-file { border: 1px solid var(--line); background: var(--bg); display: grid; align-content: start; min-width: 0; }
.srp-file.mixed { border-color: var(--pain); }
.srp-drop { border: 0; border-bottom: 1px solid var(--line); background: var(--surface-2); padding: 5px 8px; display: grid; gap: 1px; text-align: left; color: var(--ink); }
.srp-file.target .srp-drop:not(:disabled) { background: var(--hl); cursor: pointer; }
.srp-drop:disabled { cursor: default; opacity: 1; }
.srp-fname { font-family: var(--f-code); font-size: .66rem; letter-spacing: .08em; text-transform: uppercase; }
.srp-teams { font-size: .78rem; color: var(--ink-2); }
.srp-teams.bad { color: var(--pain); }
.srp-units { display: grid; gap: 4px; padding: 6px; }
.srp-unit { display: grid; gap: 0; text-align: left; border: 1px solid var(--line); border-left-width: 4px; background: var(--surface); padding: 3px 6px; color: var(--ink); }
.srp-unit code { background: none; padding: 0; font-size: .74rem; }
.srp-unit small { font-size: .7rem; color: var(--ink-2); }
.srp-unit.finance { border-left-color: var(--accent); }
.srp-unit.brand { border-left-color: var(--good); }
.srp-unit.ops { border-left-color: var(--ink-2); }
.srp-unit.shared { border-left-color: var(--pain); border-left-style: double; }
.srp-unit[aria-pressed="true"] { outline: 2px solid var(--accent); outline-offset: 1px; background: var(--hl); }
.srp-new { padding: 10px; border-style: dashed; color: var(--ink-2); font-size: .85rem; min-height: 60px; }
.srp-new.target:not(:disabled) { background: var(--hl); color: var(--ink); cursor: pointer; }
.srp-was { display: block; font-weight: 400; font-size: .66rem; color: var(--ink-2); }
`;
