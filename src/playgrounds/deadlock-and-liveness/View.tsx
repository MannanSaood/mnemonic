"use client";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  ANSWER, JOBS, LIVELOCK_TICKS, OPENING, RUN_TICKS, TIDS, canStep, deadlocked, held, init, lines, livelocked, revealed, step, waitingFor,
  type Acct, type Guess, type Mode, type RunRow, type State, type Tid,
} from "./model";

const CSS = `
.dl-stage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1fr); gap: 10px; align-items: start; }
@media (max-width: 640px) { .dl-stage { grid-template-columns: 1fr; } }
.dl-th { border: 1px solid var(--line); background: var(--surface); padding: 8px; display: grid; gap: 6px; }
.dl-th.stuck { border-color: var(--pain); background: var(--pain-bg); }
.dl-th header { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
.dl-name { font-family: var(--f-code); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }
.dl-code { margin: 0; padding: 0; list-style: none; font-family: var(--f-code); font-size: .76rem; display: grid; gap: 2px; }
.dl-code li { padding: 2px 6px; border-left: 3px solid transparent; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dl-code li.next { border-left-color: var(--accent); background: var(--hl); color: var(--ink); font-weight: 600; }
.dl-code li.blocked { border-left-color: var(--pain); background: var(--pain-bg); color: var(--pain); }
.dl-state { margin: 0; font-family: var(--f-code); font-size: .7rem; color: var(--ink-2); }
.dl-graph { border: 2px solid var(--accent); background: var(--surface); padding: 6px; display: grid; gap: 4px; }
.dl-graph svg { width: 100%; height: auto; display: block; }
.dl-graph .tnode rect { fill: var(--surface); stroke: var(--ink-2); stroke-width: 1.5; }
.dl-graph .lnode rect { fill: var(--bg); stroke: var(--line); stroke-width: 1.5; }
.dl-graph .lnode.held rect { stroke: var(--accent); fill: var(--hl); }
.dl-graph text { font-family: var(--f-code); font-size: 11px; fill: var(--ink); text-anchor: middle; dominant-baseline: middle; letter-spacing: .06em; }
.dl-graph text.small { font-size: 9px; fill: var(--ink-2); }
.dl-graph .e { fill: none; stroke-width: 2; transition: opacity .2s; }
.dl-graph .e.hold { stroke: var(--accent); }
.dl-graph .e.wait { stroke: var(--pain); stroke-dasharray: 5 4; }
.dl-graph .e.cycle { stroke: var(--pain); stroke-width: 3.5; stroke-dasharray: none; }
.dl-graph text.cyc { fill: var(--pain); font-weight: 700; font-size: 12px; }
.dl-graph text.elabel { font-size: 9px; fill: var(--ink-2); }
.dl-bal { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 0; }
.dl-bal div { background: var(--surface); padding: 3px 6px; }
.dl-bal dt { font-family: var(--f-code); font-size: .56rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.dl-bal dd { margin: 0; font-family: var(--f-code); font-size: .85rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.dl-alert { margin: 0; padding: 6px 8px; border: 1px solid var(--pain); background: var(--pain-bg); color: var(--pain); font-size: .9rem; }
.dl-ok { margin: 0; padding: 6px 8px; border: 1px solid var(--good); background: var(--good-bg); font-size: .9rem; }
.dl-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dl-runs { width: 100%; border-collapse: collapse; font-size: .85rem; }
.dl-runs th, .dl-runs td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.dl-runs th:first-child, .dl-runs td:first-child, .dl-runs td:last-child, .dl-runs th:last-child { text-align: left; }
.dl-runs th { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
.dl-runs td.bad { color: var(--pain); font-weight: 700; }
.dl-dump { margin: 0; font-family: var(--f-code); font-size: .74rem; white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); padding: 6px; }
@media (prefers-reduced-motion: reduce) { .dl-graph .e { transition: none; } }
`;

const MODES: { value: Mode; label: string; note: string }[] = [
  { value: "naive", label: "lock from, then to", note: "The obvious code" },
  { value: "ordered", label: "lock lower id first", note: "One global lock order" },
  { value: "trylock", label: "try-lock + back off", note: "Give the first lock back if the second is taken" },
];
const MODE_NAME: Record<Mode, string> = { naive: "from, then to", ordered: "lower id first", trylock: "try-lock + back off" };

const GUESSES: { value: Guess; label: string }[] = [
  { value: "serial", label: "Both finish, one after the other" },
  { value: "error", label: "One gets an error" },
  { value: "forever", label: "Both wait forever" },
];

/* ---------------- wait-for graph ---------------- */

const POS: Record<Tid | Acct, { x: number; y: number }> = {
  T1: { x: 70, y: 36 }, T2: { x: 250, y: 36 }, A: { x: 70, y: 176 }, B: { x: 250, y: 176 },
};

function edge(from: Tid | Acct, to: Tid | Acct) {
  const a = POS[from], b = POS[to];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len, shrink = dx === 0 ? 24 : 36;
  return { x1: a.x + ux * shrink, y1: a.y + uy * shrink, x2: b.x - ux * shrink, y2: b.y - uy * shrink };
}

function Graph({ st }: { st: State }) {
  const cyc = deadlocked(st);
  const edges: { k: string; from: Tid | Acct; to: Tid | Acct; kind: "hold" | "wait"; label: string }[] = [];
  for (const acc of ["A", "B"] as Acct[]) {
    const h = st.holder[acc];
    if (h) edges.push({ k: `h${acc}`, from: acc, to: h, kind: "hold", label: "held by" });
  }
  for (const t of TIDS) {
    const w = waitingFor(st, t);
    if (w) edges.push({ k: `w${t}`, from: t, to: w, kind: "wait", label: "waits for" });
  }
  return (
    <div className="dl-graph">
      <span className="label">Wait-for graph</span>
      <svg viewBox="0 0 320 212" role="img" aria-label={cyc ? "Wait-for graph with a cycle: deadlock" : `Wait-for graph: ${edges.length} edges`}>
        <defs>
          <marker id="dl-arrow-hold" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" style={{ fill: "var(--accent)" }} />
          </marker>
          <marker id="dl-arrow-wait" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" style={{ fill: "var(--pain)" }} />
          </marker>
        </defs>
        {edges.map((e) => {
          const g = edge(e.from, e.to);
          // label a third of the way along, so crossing diagonals keep their labels apart
          const a = POS[e.from], b = POS[e.to];
          const vertical = a.x === b.x;
          const lx = a.x + (b.x - a.x) * 0.32 + (vertical ? (a.x < 160 ? 30 : -30) : 0);
          const ly = a.y + (b.y - a.y) * 0.32 + (vertical ? 0 : -8);
          return (
            <g key={e.k}>
              <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} className={"e " + e.kind + (cyc ? " cycle" : "")}
                markerEnd={`url(#dl-arrow-${cyc || e.kind === "wait" ? "wait" : "hold"})`} />
              <text x={lx} y={ly} className="elabel">{e.label}</text>
            </g>
          );
        })}
        {TIDS.map((t) => (
          <g key={t} className="tnode">
            <rect x={POS[t].x - 34} y={POS[t].y - 18} width={68} height={36} />
            <text x={POS[t].x} y={POS[t].y - 4}>{t}</text>
            <text x={POS[t].x} y={POS[t].y + 9} className="small">{JOBS[t].from}→{JOBS[t].to}</text>
          </g>
        ))}
        {(["A", "B"] as Acct[]).map((a) => (
          <g key={a} className={"lnode" + (st.holder[a] ? " held" : "")}>
            <rect x={POS[a].x - 34} y={POS[a].y - 18} width={68} height={36} />
            <text x={POS[a].x} y={POS[a].y - 4}>LOCK {a}</text>
            <text x={POS[a].x} y={POS[a].y + 9} className="small">{st.holder[a] ? `held · ${st.holder[a]}` : "free"}</text>
          </g>
        ))}
        {cyc && <text x={160} y={106} className="cyc">CYCLE</text>}
      </svg>
    </div>
  );
}

/* ---------------- threads ---------------- */

function describe(st: State, t: Tid): string {
  const th = st.th[t];
  const h = held(st, t);
  const w = waitingFor(st, t);
  const parts = [h.length ? `holding ${h.join(", ")}` : "holding nothing"];
  if (w) parts.push(`blocked on ${w}`);
  else if (th.sleep > 0) parts.push(`backing off, ${th.sleep} tick${th.sleep === 1 ? "" : "s"} left`);
  else parts.push("runnable");
  return parts.join(" · ");
}

function ThreadCard({ st, t, onStep }: { st: State; t: Tid; onStep: () => void }) {
  const th = st.th[t];
  const w = waitingFor(st, t);
  const src = lines(st.mode, t);
  const ok = canStep(st, t);
  return (
    <div className={"dl-th" + (w && deadlocked(st) ? " stuck" : "")}>
      <header>
        <span className="dl-name">{t} · transfer {JOBS[t].from} → {JOBS[t].to}</span>
        <PgButton primary={ok} onClick={onStep} disabled={!ok} title={ok ? `Run ${t}'s next line` : `${t} is blocked on lock ${w}`}>
          {ok ? (th.sleep > 0 ? "Sleep 1 tick" : `Step ${t}`) : `blocked on ${w}`}
        </PgButton>
      </header>
      <ol className="dl-code" aria-label={`${t}'s code`}>
        {src.map((l, i) => (
          <li key={i} className={i === th.pc && th.sleep === 0 ? (w ? "next blocked" : "next") : i === 2 && st.mode === "trylock" && th.sleep > 0 ? "next" : ""}>{l}</li>
        ))}
      </ol>
      <p className="dl-state">{describe(st, t)} · {th.transfers} done{st.mode === "trylock" ? ` · ${th.retries} retries` : ""}</p>
    </div>
  );
}

/* ---------------- runs and result ---------------- */

const rowName = (r: RunRow) => MODE_NAME[r.mode] + (r.mode === "trylock" ? (r.jitter ? ", jitter" : ", fixed wait") : "");

function Runs({ rows }: { rows: RunRow[] }) {
  if (!rows.length) return null;
  return (
    <table className="dl-runs">
      <caption className="label" style={{ textAlign: "left" }}>Your {RUN_TICKS}-tick runs, both cores in lockstep</caption>
      <thead><tr><th>Code</th><th>Transfers</th><th>Retries</th><th>Ended</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{rowName(r)}</td>
            <td className={r.transfers === 0 ? "bad" : ""}>{r.transfers}</td>
            <td>{r.retries}</td>
            <td className={r.deadlocked || r.livelocked ? "bad" : ""}>{r.deadlocked ? "deadlock" : r.livelocked ? "livelock" : "progress"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ rows }: { rows: RunRow[] }) {
  const last = (f: (r: RunRow) => boolean) => [...rows].reverse().find(f);
  const naive = last((r) => r.mode === "naive");
  const ordered = last((r) => r.mode === "ordered");
  const fixed = last((r) => r.mode === "trylock" && !r.jitter);
  const jit = last((r) => r.mode === "trylock" && r.jitter);
  if (!naive || (!ordered && !fixed && !jit)) {
    return <p className="muted">{rows.length ? "Now run the same 40 ticks with another fix and compare the rows." : ""}</p>;
  }
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your numbers</span>
      <p>
        In {RUN_TICKS} ticks: locking from-then-to moved money {naive.transfers} times and {naive.deadlocked ? "ended in a deadlock" : "got lucky"}.
        {ordered && <> Lower id first: {ordered.transfers} transfers, no cycle.</>}
        {fixed && <> Try-lock with a fixed wait: {fixed.transfers} transfers after {fixed.retries} retries{fixed.livelocked ? ", both threads busy and getting nowhere" : ""}.</>}
        {jit && <> With jitter: {jit.transfers} transfers after {jit.retries} retries.</>}
      </p>
      <p className="pg-takeaway">
        A deadlock needs a cycle, and two locks taken in opposite orders are enough to make one. One global lock order removes
        the cycle for good. Backing off breaks it at run time, but only if the threads stop retrying in step, which is what the
        random jitter is for.
      </p>
    </div>
  );
}

function Dump({ st }: { st: State }) {
  return (
    <pre className="dl-dump" aria-label="Thread dump">
      {TIDS.map((t) => `${t}  transfer(${JOBS[t].from} → ${JOBS[t].to})  ${describe(st, t)}`).join("\n")}
    </pre>
  );
}

export default function DeadlockAndLiveness() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const cyc = deadlocked(st);
  const live = livelocked(st);
  const total = st.balance.A + st.balance.B;
  return (
    <PgFrame title="Two transfers, two locks" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        A ledger guards each account with its own lock. Thread T1 keeps moving 50 from A to B; thread T2 keeps moving 30 from
        B to A. Step one thread at a time, or tick both cores at once. <b>Arrows show who holds which lock and who waits for
        which. A loop of arrows is a deadlock.</b>
      </p>

      <PgPredict<Guess>
        question="Both transfers start at the same moment on two cores. Each locks its from account, then its to account. What happens?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed(st)}
        answer={ANSWER}
        explain="T1 locks A while T2 locks B. Then T1 waits for B, which T2 holds, and T2 waits for A, which T1 holds. That is a cycle in the wait-for graph. No lock times out and nothing reports an error: both threads wait forever."
      />

      <div className="dl-row">
        <span className="label">Code</span>
        <PgChoice<Mode> label="Locking strategy" value={st.mode} options={MODES} onChange={(m) => dispatch({ type: "mode", mode: m })} />
        {st.mode === "trylock" && (
          <PgChoice<string> label="Backoff" value={st.jitter ? "jitter" : "fixed"}
            options={[{ value: "fixed", label: "fixed 2-tick wait" }, { value: "jitter", label: "random 1-4 ticks" }]}
            onChange={(v) => dispatch({ type: "jitter", on: v === "jitter" })} />
        )}
      </div>

      <div className="dl-stage">
        <ThreadCard st={st} t="T1" onStep={() => dispatch({ type: "step", t: "T1" })} />
        <Graph st={st} />
        <ThreadCard st={st} t="T2" onStep={() => dispatch({ type: "step", t: "T2" })} />
      </div>

      <div className="dl-row">
        <PgButton primary onClick={() => dispatch({ type: "tick" })} disabled={cyc} title="Both cores run one step of their thread">Tick both cores</PgButton>
        <PgButton onClick={() => dispatch({ type: "run" })} title={`Start fresh and run ${RUN_TICKS} ticks in lockstep`}>Run {RUN_TICKS} ticks</PgButton>
        <PgButton onClick={() => dispatch({ type: "restart" })}>Start the transfers again</PgButton>
        <span className="muted">tick {st.ticks}</span>
      </div>

      {cyc && <p className="dl-alert" role="status">Deadlock: every thread in the cycle waits for a lock another thread in the cycle holds. Nothing in the program can break it. Start again, or change the code.</p>}
      {!cyc && live && <p className="dl-alert" role="status">Livelock: both threads are busy taking, releasing and retrying, but no money has moved for {st.ticks - st.lastProgress} ticks. They back off for the same time and collide again every round.</p>}
      {!cyc && !live && st.th.T1.transfers + st.th.T2.transfers > 0 && <p className="dl-ok" role="status">Money is moving: {st.th.T1.transfers + st.th.T2.transfers} transfers so far.</p>}

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Thread dump</span>
          <Dump st={st} />
          <dl className="dl-bal">
            <div><dt>A</dt><dd>{st.balance.A}</dd></div>
            <div><dt>B</dt><dd>{st.balance.B}</dd></div>
            <div><dt>A + B</dt><dd>{total}{total === 2 * OPENING ? " ✓" : ""}</dd></div>
          </dl>
          <span className="label">What happened, newest first</span>
          <PgLog entries={st.log} empty="Nothing yet. Step a thread or tick both cores." reduced={reduced} />
        </div>
        <div className="pg-card">
          <span className="label">Compare the fixes</span>
          <Runs rows={st.rows} />
          <dl className="pg-stats">
            <div><dt>Transfers</dt><dd>{st.th.T1.transfers + st.th.T2.transfers}</dd></div>
            <div className={st.deadlocks ? "bad" : ""}><dt>Deadlocks hit</dt><dd>{st.deadlocks}</dd></div>
            <div><dt>Retries</dt><dd>{st.th.T1.retries + st.th.T2.retries}</dd></div>
            <div><dt>Ticks spent blocked</dt><dd>{st.th.T1.waited + st.th.T2.waited}</dd></div>
          </dl>
          <Result rows={st.rows} />
          <p className="pg-note">A model: one tick is one line per core, T1 goes first when both want the same free lock, and livelock is flagged after {LIVELOCK_TICKS} ticks without a transfer.</p>
        </div>
      </div>

      <PgSources links={[
        { title: "The Deadlock Empire", href: "https://deadlockempire.github.io/" },
        { title: "ThreadMentor's dining philosophers visualisation", href: "https://pages.mtu.edu/~shene/NSF-3/e-Book/MUTEX/VISUAL/VISUAL-mutex-philos.html" },
        { title: "HMC CS134 deadlock simulator", href: "https://www.cs.hmc.edu/courses/2024/fall/cs134/lessons/w06/l02/deadlock/" },
      ]} />
    </PgFrame>
  );
}
