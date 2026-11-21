"use client";
import { useMemo, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  init, LEVELS, modesFor, nextSql, step, tally, WORKLOADS,
  type Action, type Challenge, type Level, type Mode, type State, type Tx, type Workload,
} from "./model";

const MODE_LABEL: Record<Mode, string> = { plain: "Plain SELECT", forUpdate: "SELECT ... FOR UPDATE", atomic: "Atomic UPDATE" };

const CHALLENGES: { id: Challenge; title: string; note: string }[] = [
  { id: "lost", title: "Lose a sale at read committed", note: "both read 10 before either wrote; the second UPDATE wrote its own 10 - 2 over the first" },
  { id: "readSkew", title: "Make the balance report add up to the wrong total", note: "at read committed each statement sees the latest commit, so the two reads straddle the transfer" },
  { id: "blocked40001", title: "Watch repeatable read refuse the lost update with 40001", note: "the row changed after the snapshot, so updating it would overwrite a write this transaction never saw" },
  { id: "skewRR", title: "Leave nobody on call at repeatable read", note: "the two transactions wrote different rows, so snapshot isolation saw no conflict" },
  { id: "ssi", title: "Watch serializable stop the write skew", note: "each read a row the other wrote: a cycle no serial order can produce" },
  { id: "fixedRC", title: "Keep both sales at read committed with overlapping transactions", note: "FOR UPDATE or an atomic UPDATE makes the second checkout wait and then see the new stock" },
];

const START: Record<Workload, string> = { stock: "stock 10", oncall: "alice 1 · bob 1 (1 = on call)", report: "a 100 · b 50" };

const plural = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Lane({ st, tx, dispatch }: { st: State; tx: Tx; dispatch: (a: Action) => void }) {
  const t = st.txs[tx];
  const w = WORKLOADS.find((x) => x.value === st.workload)!;
  const sql = nextSql(st, tx);
  let btn = null;
  if (t.status === "aborted") btn = <PgButton primary onClick={() => dispatch({ type: "retry", tx })}>Retry T{tx + 1}</PgButton>;
  else if (t.status === "committed") btn = <span className="iso-done">committed</span>;
  else if (t.status === "waiting") btn = <span className="iso-wait">waiting for T{tx === 0 ? 2 : 1}'s lock</span>;
  else btn = <PgButton primary onClick={() => dispatch({ type: "step", tx })}>Run</PgButton>;
  return (
    <div className={"iso-lane s-" + t.status}>
      <div className="iso-lhead"><b>T{tx + 1}</b> <span>{tx === 0 ? w.t1 : w.t2}{t.attempt > 1 ? ` · attempt ${t.attempt}` : ""}</span></div>
      <code className="iso-next">{sql ?? (t.status === "aborted" ? "rolled back" : "done")}</code>
      {btn}
    </div>
  );
}

type Guess = "5" | "8" | "error";

export default function IsolationPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const w = WORKLOADS.find((x) => x.value === st.workload)!;
  const tallies = useMemo(() => LEVELS.map((l) => ({ level: l, t: tally(st.workload, l.value, st.mode) })), [st.workload, st.mode]);
  const revealed = st.done.includes("lost") || (!!st.outcome && st.workload === "stock" && st.level === "rc" && st.mode === "plain");
  const preset = (order: string) => {
    dispatch({ type: "restart" });
    for (const c of order) dispatch({ type: "step", tx: (Number(c) - 1) as Tx });
  };
  const o = st.outcome;
  const s = st.stats;

  return (
    <PgFrame title="Two transactions, one timeline" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="Read committed. Stock is 10. T1 sells 3 and T2 sells 2, each by reading the stock and writing back stock minus its quantity. Both read before either writes. What is the stock once both have committed?"
        options={[{ value: "5", label: "5" }, { value: "8", label: "8, one sale lost" }, { value: "error", label: "One of them gets an error" }]}
        value={guess} onChange={setGuess} revealed={revealed} answer="8"
        explain={<>Both read 10. T1 writes 7 and commits. T2's UPDATE waited for T1's row lock, and at read committed it then simply runs on the new row: it writes 10 - 2 = 8, the number it computed from its stale read. Nothing failed, and T1's sale is gone. Repeatable read would have stopped T2 with error 40001 instead.</>}
      />

      <div className="pg-req">
        <span className="label">Set up the race</span>
        <div className="iso-set"><span className="pg-place">Workload</span>
          <PgChoice<Workload> label="Workload" value={st.workload} onChange={(workload) => dispatch({ type: "workload", workload })} options={WORKLOADS.map((x) => ({ value: x.value, label: x.label }))} /></div>
        <div className="iso-set"><span className="pg-place">Isolation</span>
          <PgChoice<Level> label="Isolation level" value={st.level} onChange={(level) => dispatch({ type: "level", level })} options={LEVELS} /></div>
        <div className="iso-set"><span className="pg-place">Read with</span>
          <PgChoice<Mode> label="How the transactions read" value={st.mode} onChange={(mode) => dispatch({ type: "mode", mode })} options={modesFor(st.workload).map((m) => ({ value: m, label: MODE_LABEL[m] }))} /></div>
        <p className="pg-rule">Correct when: <b>{w.rule}</b>. Starting data: <code>{START[st.workload]}</code>.</p>
      </div>

      <div className="pg-req">
        <span className="label">Choose the interleaving · run one statement at a time</span>
        <div className="iso-lanes">
          <Lane st={st} tx={0} dispatch={dispatch} />
          <Lane st={st} tx={1} dispatch={dispatch} />
        </div>
        <div className="pg-actions">
          <PgButton onClick={() => preset(st.workload === "report" ? "1222" : "1212")}>Overlap them</PgButton>
          <PgButton onClick={() => preset("111222")}>T1, then T2</PgButton>
          <PgButton onClick={() => dispatch({ type: "restart" })}>Start over</PgButton>
        </div>

        <div className="iso-time" role="table" aria-label="Timeline of statements">
          <div className="iso-row head" role="row"><span role="columnheader">T1</span><span role="columnheader">committed data</span><span role="columnheader">T2</span></div>
          {st.events.length === 0 && <p className="pg-empty">Nothing has run yet. Press Run on T1 or T2.</p>}
          {st.events.map((e, i) => {
            const cell = (
              <span className={"iso-ev " + e.kind + (i === st.events.length - 1 && !reduced ? " fresh" : "")}>
                <code>{e.sql}</code>
                <em>{e.result}</em>
              </span>
            );
            return (
              <div key={i} className="iso-row" role="row">
                <span role="cell">{e.tx === 0 ? cell : null}</span>
                <span role="cell" className="iso-db">{e.db}</span>
                <span role="cell">{e.tx === 1 ? cell : null}</span>
              </div>
            );
          })}
        </div>

        {o && (
          <div className={"pg-entry" + (o.anomaly ? " fail" : " ok")} aria-live="polite">
            <p><b>{o.anomaly ? `Anomaly: ${o.anomaly}.` : o.aborted ? "Correct, after a rollback." : "Correct."}</b> {o.text}
              {o.aborted > 0 && !o.anomaly && " A transaction was rolled back with an error; press Retry to run it again from the start, as the application must."}</p>
          </div>
        )}
      </div>

      <div className="pg-req">
        <span className="label">Every interleaving of this workload ({MODE_LABEL[st.mode]}), no retries</span>
        <table className="iso-tally">
          <thead><tr><th>Level</th><th>Orders</th><th>Correct</th><th>Anomaly</th><th>Rolled back</th></tr></thead>
          <tbody>
            {tallies.map(({ level, t }) => (
              <tr key={level.value} className={level.value === st.level ? "cur" : ""}>
                <td>{level.label}</td><td>{t.histories}</td><td>{t.correct}</td>
                <td className={t.anomalies ? "bad" : ""}>{t.anomalies}</td><td>{t.aborted}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Rolled back means PostgreSQL raised 40001 (or a deadlock) and the application has to retry. A retry runs after the other transaction committed, so it sees its write.</p>
      </div>

      <div className="pg-req">
        <span className="label">Challenges: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="iso-list">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      {s.histories >= 2 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your runs showed</span>
          <p>
            You ran {plural(s.histories, "history", "histories")}: {plural(s.anomalies, "anomaly", "anomalies")} committed without any error, {plural(s.aborts, "transaction")} rolled back with a serialization error, and {plural(s.retries, "retry", "retries")} that then succeeded or failed on their own.
          </p>
          <p className="pg-takeaway">
            Every anomaly you produced committed cleanly: the database reported success and the data was wrong. Stronger levels do not make the race go away; they turn it into an error you can see. Run at repeatable read or serializable, and retry the whole transaction on 40001, or lock what you read with FOR UPDATE.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Hermitage (Kleppmann), isolation tests per database", href: "https://github.com/ept/hermitage" },
        { title: "Jepsen's consistency models map", href: "https://jepsen.io/consistency" },
        { title: "the PostgreSQL transaction isolation chapter", href: "https://www.postgresql.org/docs/current/transaction-iso.html" },
      ]} />

      <style>{`
        .iso-set { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
        .iso-set .pg-place { min-width: 6.5em; }
        .iso-lanes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .iso-lane { border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; display: grid; gap: 6px; align-content: start; justify-items: start; }
        .iso-lane.s-waiting { border-color: var(--accent); border-style: dashed; }
        .iso-lane.s-aborted { border-color: var(--pain); }
        .iso-lane.s-committed { border-color: var(--good); }
        .iso-lhead { display: flex; gap: 6px; align-items: baseline; font-size: .88rem; }
        .iso-lhead b { font-family: var(--f-code); }
        .iso-lhead span { color: var(--ink-2); }
        .iso-next { font-size: .72rem; overflow-wrap: anywhere; }
        .iso-wait { font-family: var(--f-code); font-size: .68rem; color: var(--accent); text-transform: uppercase; letter-spacing: .06em; }
        .iso-done { font-family: var(--f-code); font-size: .68rem; color: var(--good); text-transform: uppercase; letter-spacing: .06em; }
        .iso-time { display: grid; gap: 2px; background-image: linear-gradient(var(--grid) 1px, transparent 1px); background-size: 100% 16px; }
        .iso-row { display: grid; grid-template-columns: minmax(0, 1fr) 7.5em minmax(0, 1fr); gap: 6px; align-items: start; }
        .iso-row.head span { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
        .iso-db { font-family: var(--f-code); font-size: .66rem; color: var(--ink-2); text-align: center; padding-top: 4px; }
        .iso-ev { display: grid; gap: 1px; border-left: 3px solid var(--line); background: var(--surface); padding: 3px 6px; }
        .iso-ev code { font-size: .68rem; background: none; padding: 0; overflow-wrap: anywhere; }
        .iso-ev em { font-style: normal; font-size: .8rem; }
        .iso-ev.ok { border-left-color: var(--accent); }
        .iso-ev.commit { border-left-color: var(--good); }
        .iso-ev.commit em { color: var(--good); }
        .iso-ev.wait { border-left-color: var(--accent); border-left-style: dashed; }
        .iso-ev.wait em { color: var(--accent); }
        .iso-ev.error { border-left-color: var(--pain); background: var(--pain-bg); }
        .iso-ev.error em { color: var(--pain); }
        .iso-ev.note em { color: var(--ink-2); }
        .iso-ev.fresh { animation: pg-hop .3s var(--ease) both; }
        .iso-tally { width: 100%; border-collapse: collapse; font-size: .85rem; }
        .iso-tally th { text-align: left; font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
        .iso-tally td, .iso-tally th { border-bottom: 1px solid var(--line); padding: 3px 6px 3px 0; }
        .iso-tally tr.cur td { font-weight: 600; }
        .iso-tally td.bad { color: var(--pain); }
        .iso-list { list-style: none; padding-left: 0 !important; }
        .iso-list li.got { color: var(--good); }
        @media (max-width: 520px) { .iso-row { grid-template-columns: minmax(0, 1fr) 4.5em minmax(0, 1fr); } .iso-lanes { grid-template-columns: 1fr; } }
        @media (prefers-reduced-motion: reduce) { .iso-ev.fresh { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
