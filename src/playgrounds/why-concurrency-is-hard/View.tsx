"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ANSWER, BATCH, LINES, PROGRAMS, START, TIDS, canStep, finished, nextOp, outcomes, revealed, step,
  init, type Batch, type Guess, type Mode, type State, type Tid,
} from "./model";

const CSS = `
.wch-stage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .8fr) minmax(0, 1fr); gap: 10px; align-items: stretch; }
@media (max-width: 640px) { .wch-stage { grid-template-columns: 1fr; } }
.wch-th { border: 1px solid var(--line); background: var(--surface); padding: 8px; display: grid; gap: 6px; align-content: start; }
.wch-th.done { border-style: dashed; }
.wch-th header { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.wch-name { font-family: var(--f-code); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }
.wch-code { margin: 0; padding: 0; list-style: none; font-family: var(--f-code); font-size: .8rem; display: grid; gap: 2px; }
.wch-code li { padding: 2px 6px; border-left: 3px solid transparent; color: var(--ink-2); }
.wch-code li.ran { color: var(--ink); }
.wch-code li.next { border-left-color: var(--accent); background: var(--hl); color: var(--ink); font-weight: 600; }
.wch-code li.blocked { border-left-color: var(--pain); background: var(--pain-bg); }
.wch-reg { font-family: var(--f-code); font-size: .74rem; color: var(--ink-2); margin: 0; }
.wch-reg b { color: var(--ink); }
.wch-mem { border: 2px solid var(--accent); background: var(--surface); padding: 8px; display: grid; gap: 6px; align-content: center; justify-items: center; text-align: center; }
.wch-val { font-family: var(--f-code); font-size: 2.2rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.wch-val.bad { color: var(--pain); }
.wch-val.good { color: var(--good); }
.wch-lock { font-family: var(--f-code); font-size: .64rem; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line); padding: 2px 6px; }
.wch-lock.held { border-color: var(--accent); color: var(--accent); font-weight: 700; }
.wch-trace { display: flex; flex-wrap: wrap; gap: 4px; min-height: 1.8em; margin: 0; padding: 0; list-style: none; }
.wch-trace li { font-family: var(--f-code); font-size: .7rem; border: 1px solid var(--line); padding: 2px 6px; background: var(--surface); }
.wch-trace li.A { border-left: 3px solid var(--accent); }
.wch-trace li.B { border-left: 3px solid var(--ink-2); }
.wch-trace li.bad { background: var(--pain-bg); border-color: var(--pain); color: var(--pain); font-weight: 600; }
.wch-fresh { animation: pg-hop .3s var(--ease) both; }
.wch-note { margin: 0; font-size: .92rem; border-left: 3px solid var(--accent); padding: 4px 8px; background: var(--surface); }
.wch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 4px; }
.wch-cell { font-family: var(--f-code); font-size: .7rem; border: 1px solid var(--line); background: var(--bg); color: var(--ink-2); padding: 4px 2px; display: grid; gap: 1px; justify-items: center; cursor: pointer; }
.wch-cell .k { letter-spacing: .08em; }
.wch-cell .k i { font-style: normal; color: var(--accent); font-weight: 700; }
.wch-cell .v { font-size: .62rem; }
.wch-cell.ok { background: var(--good-bg); border-color: var(--good); color: var(--ink); }
.wch-cell.lost { background: var(--pain-bg); border-color: var(--pain); color: var(--pain); }
.wch-cell.gone { opacity: .45; text-decoration: line-through; }
.wch-cell.cur { outline: 2px solid var(--accent); outline-offset: 1px; }
.wch-runs { width: 100%; border-collapse: collapse; font-size: .85rem; }
.wch-runs th, .wch-runs td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.wch-runs th:first-child, .wch-runs td:first-child, .wch-runs th:nth-child(2), .wch-runs td:nth-child(2) { text-align: left; }
.wch-runs th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.wch-runs td.bad { color: var(--pain); font-weight: 700; }
.wch-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
@media (prefers-reduced-motion: reduce) { .wch-fresh { animation: none; } }
`;

const MODES: { value: Mode; label: string; note: string }[] = [
  { value: "plain", label: "calls++", note: "No protection" },
  { value: "lock", label: "with a lock", note: "mu.lock() ... mu.unlock() around the increment" },
  { value: "atomic", label: "atomic add", note: "calls.add(1), one indivisible step" },
];

const GUESSES: { value: Guess; label: string }[] = [
  { value: "all", label: "All 20" },
  { value: "half", label: "About 10" },
  { value: "two", label: "Only 2" },
];

const SCHED_NAME = { slices: "time slices", coin: "coin flip per step" } as const;
const MODE_NAME: Record<Mode, string> = { plain: "calls++", lock: "lock", atomic: "atomic add" };

function ThreadCol({ st, t, onStep, reduced }: { st: State; t: Tid; onStep: () => void; reduced: boolean }) {
  const th = st.th[t];
  const prog = PROGRAMS[st.mode];
  const op = nextOp(st, t);
  const blocked = op !== null && !canStep(st, t);
  return (
    <div className={"wch-th" + (op === null ? " done" : "")}>
      <header>
        <span className="wch-name">Request {t}</span>
        <PgButton primary={canStep(st, t)} onClick={onStep} disabled={!canStep(st, t)}
          title={op === null ? `${t} is done` : blocked ? `${t} waits: the other thread holds the lock` : `Run ${t}'s next line`}>
          {op === null ? "done" : blocked ? "waiting for lock" : `Step ${t}`}
        </PgButton>
      </header>
      <ol className="wch-code" aria-label={`Request ${t}'s code`}>
        {prog.map((o, i) => (
          <li key={i} className={i < th.pc ? "ran" : i === th.pc ? (blocked ? "next blocked" : "next") : ""}>{LINES[o]}</li>
        ))}
      </ol>
      <p className="wch-reg" key={th.pc} >
        <span className={reduced ? "" : "wch-fresh"}>tmp (this thread only): <b>{th.reg ?? "·"}</b></span>
      </p>
    </div>
  );
}

function OrderKey({ order, upto }: { order: string; upto: number }) {
  return <span className="k">{order.split("").map((c, i) => (i < upto ? <i key={i}>{c}</i> : <span key={i}>{c}</span>))}</span>;
}

function Orders({ st, dispatch }: { st: State; dispatch: (a: { type: "replay"; order: string }) => void }) {
  const plain = outcomes("plain");
  const possibleNow = new Set(outcomes(st.mode).filter((o) => o.calls !== null).map((o) => o.order));
  const found = Object.keys(st.seen);
  const wrongFound = found.filter((k) => st.seen[k] !== START + 2 && st.mode === "plain").length;
  return (
    <div className="pg-card">
      <span className="label">All 20 orders of the six steps · click one to replay it</span>
      <div className="wch-grid" role="list" aria-label="The 20 possible orders">
        {plain.map(({ order, calls }) => {
          const known = st.showAll || order in st.seen;
          const gone = !possibleNow.has(order);
          const cls = gone ? " gone" : known ? (calls === START + 2 ? " ok" : " lost") : "";
          const cur = st.order.length > 0 && order.startsWith(st.order) ? " cur" : "";
          return (
            <button key={order} role="listitem" className={"wch-cell" + cls + cur} onClick={() => dispatch({ type: "replay", order })}
              title={gone ? `Impossible with ${MODE_NAME[st.mode]}` : known ? `Ends with calls = ${calls}` : "Not played yet"}
              aria-label={`Order ${order}: ${gone ? "impossible in this mode" : known ? `ends at ${calls}` : "not played yet"}`}>
              <OrderKey order={order} upto={cur ? st.order.length : 0} />
              <span className="v">{gone ? "can't happen" : known ? (calls === START + 2 ? `${calls} ✓` : `${calls} lost 1`) : "?"}</span>
            </button>
          );
        })}
      </div>
      <div className="wch-row">
        <span className="muted">
          {st.mode === "plain"
            ? `You have played ${found.length} of 20 orders${wrongFound ? `; ${wrongFound} lost a count` : ""}.`
            : `With ${MODE_NAME[st.mode]}, only ${possibleNow.size} of the 20 orders can happen.`}
        </span>
      </div>
    </div>
  );
}

function Batches({ batches }: { batches: Batch[] }) {
  if (!batches.length) return null;
  return (
    <table className="wch-runs">
      <caption className="label" style={{ textAlign: "left" }}>Your scheduler runs</caption>
      <thead><tr><th>Code</th><th>Scheduler</th><th>Runs</th><th>Lost</th><th>Billed / served</th></tr></thead>
      <tbody>
        {batches.map((b, i) => (
          <tr key={i}>
            <td>{MODE_NAME[b.mode]}</td><td>{SCHED_NAME[b.sched]}</td><td>{b.runs}</td>
            <td className={b.lost ? "bad" : ""}>{b.lost} ({((b.lost / b.runs) * 100).toFixed(1)}%)</td>
            <td>{b.billed.toLocaleString("en-US")} / {b.served.toLocaleString("en-US")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ st }: { st: State }) {
  const plainSlices = [...st.batches].reverse().find((b) => b.mode === "plain" && b.sched === "slices");
  const plainCoin = [...st.batches].reverse().find((b) => b.mode === "plain" && b.sched === "coin");
  const fixed = [...st.batches].reverse().find((b) => b.mode !== "plain");
  if (!plainSlices && !plainCoin && st.hand.lost === 0) return null;
  const bad = outcomes("plain").filter((o) => o.calls !== START + 2).length;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your numbers</span>
      <p>
        By hand you played {st.hand.runs} run{st.hand.runs === 1 ? "" : "s"} and {st.hand.lost} lost a count.
        {" "}Of all 20 orders, {bad} lose one.
        {plainSlices && <> With time slices, {plainSlices.runs} runs lost only {plainSlices.lost}: that is the test that passed.</>}
        {plainCoin && <> With a coin flip before every step, closer to two cores, {plainCoin.lost} of {plainCoin.runs} lost one.</>}
        {fixed && <> With {MODE_NAME[fixed.mode]}, {fixed.lost} of {fixed.runs}.</>}
      </p>
      <p className="pg-takeaway">
        <code>calls++</code> is three steps, and almost every way to interleave them is wrong. The bug hides because a scheduler
        rarely switches threads inside a three-step window, not because the window is safe.
        {fixed ? " A lock or an atomic add does not make the bad orders rarer; it makes them impossible." : " Now switch to a lock or an atomic add and run the scheduler again."}
      </p>
    </div>
  );
}

export default function WhyConcurrencyIsHard() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const done = finished(st);
  const lastBad = st.trace.length > 0 && st.trace[st.trace.length - 1].bad;
  return (
    <PgFrame title="Interleave it" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        A usage meter has counted {START} billable calls. Two requests arrive on two threads, and each runs{" "}
        <code>calls = calls + 1</code>, which the CPU does as three steps: read, add, write. <b>You are the scheduler:
        step the threads in any order, or replay one of the 20 possible orders, and see which ones lose a count.</b>
      </p>

      <PgPredict<Guess>
        question="Each thread runs read, add, write once. Their six steps can interleave in 20 different orders. In how many of them does calls end at 43, with both requests counted?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed(st)}
        answer={ANSWER}
        explain="Only the 2 serial orders, AAABBB and BBBAAA, are right. In the other 18, both threads read 41 before either writes, so both write 42 and one count disappears. Press Show all 20 to see every outcome."
      />

      <div className="wch-row">
        <span className="label">Code</span>
        <PgChoice<Mode> label="How the increment is protected" value={st.mode} options={MODES} onChange={(m) => dispatch({ type: "mode", mode: m })} />
      </div>

      <div className="wch-stage">
        <ThreadCol st={st} t="A" onStep={() => dispatch({ type: "step", t: "A" })} reduced={reduced} />
        <div className="wch-mem" aria-live="polite">
          <span className="label">calls · shared memory</span>
          <span key={st.calls} className={"wch-val" + (done ? (st.calls === START + 2 ? " good" : " bad") : "") + (reduced ? "" : " wch-fresh")}>{st.calls}</span>
          <span className="muted">{done ? (st.calls === START + 2 ? "both counted" : "1 call lost") : `expect ${START + 2}`}</span>
          {st.mode === "lock" && <span className={"wch-lock" + (st.holder ? " held" : "")}>mu: {st.holder ? `held by ${st.holder}` : "free"}</span>}
          {done && <PgButton primary onClick={() => dispatch({ type: "again" })}>Two more requests</PgButton>}
        </div>
        <ThreadCol st={st} t="B" onStep={() => dispatch({ type: "step", t: "B" })} reduced={reduced} />
      </div>

      <ol className="wch-trace" aria-label="Steps so far">
        {st.trace.length === 0 && <li>no steps yet</li>}
        {st.trace.map((x, i) => (
          <li key={x.id} className={x.t + (x.bad ? " bad" : "") + (i === st.trace.length - 1 && !reduced ? " wch-fresh" : "")}>{x.text}</li>
        ))}
      </ol>
      <p className="wch-note" role="status" style={lastBad ? { borderLeftColor: "var(--pain)" } : undefined}>{st.note}</p>

      <Orders st={st} dispatch={dispatch} />

      <div className="pg-card">
        <span className="label">Let a scheduler pick: {BATCH} runs of the current code</span>
        <div className="wch-row">
          <PgButton onClick={() => dispatch({ type: "batch", sched: "slices" })} title="Threads switch rarely, as on one core with time slices">Run {BATCH} · time slices</PgButton>
          <PgButton onClick={() => dispatch({ type: "batch", sched: "coin" })} title="A coin flip before every step, closer to two cores at once">Run {BATCH} · coin flip per step</PgButton>
          {!st.showAll && <PgButton onClick={() => dispatch({ type: "showAll" })}>Show all 20</PgButton>}
        </div>
        <Batches batches={st.batches} />
        <dl className="pg-stats">
          <div><dt>Orders played</dt><dd>{Object.keys(st.seen).length} / 20</dd></div>
          <div className={st.hand.lost ? "bad" : ""}><dt>Lost by hand</dt><dd>{st.hand.lost}</dd></div>
          <div className={st.batches.some((b) => b.lost) ? "bad" : ""}><dt>Lost by scheduler</dt><dd>{st.batches.reduce((n, b) => n + b.lost, 0)}</dd></div>
          <div><dt>Threads</dt><dd>{TIDS.length}</dd></div>
        </dl>
        <p className="pg-note">A model. Time slices switch threads after 1 step in 100; real slices are millions of instructions long, so on one core the bug is rarer still. On two cores both threads really run at once, which is closer to the coin flip.</p>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "The Deadlock Empire (you play the scheduler)", href: "https://deadlockempire.github.io/" },
        { title: "OSTEP, Concurrency: An Introduction", href: "https://pages.cs.wisc.edu/~remzi/OSTEP/threads-intro.pdf" },
        { title: "The Go memory model", href: "https://go.dev/ref/mem" },
      ]} />
    </PgFrame>
  );
}
