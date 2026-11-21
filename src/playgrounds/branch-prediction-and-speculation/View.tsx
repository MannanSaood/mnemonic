"use client";
import { useEffect, useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BASE, BRANCHLESS, CHALLENGES, N, PENALTY, PREDICTOR_NAMES,
  compare, init, label, msPerMillion, step,
  type Action, type Code, type Data, type Prediction, type Predictor, type State,
} from "./model";

const LOOPS: Record<Lang, Record<Code, string>> = {
  go: {
    branch: "for _, x := range xs { if x >= t { sum += x } }",
    branchless: "for _, x := range xs { mask := (t - 1 - x) >> 63; sum += x & mask } // all ones when x >= t",
  },
  python: {
    branch: "total = sum(x for x in xs if x >= t)",
    branchless: "total = np.where(xs >= t, xs, 0).sum()  # NumPy: compare, select, add; no branch per element",
  },
  typescript: {
    branch: "for (const x of xs) if (x >= t) sum += x;",
    branchless: "for (const x of xs) sum += x & ((t - 1 - x) >> 31); // all ones when x >= t",
  },
  rust: {
    branch: "for &x in xs { if x >= t { sum += x } }",
    branchless: "for &x in xs { sum += x * (x >= t) as i64 }",
  },
};

const DATA: { value: Data; label: string; note: string }[] = [
  { value: "sorted", label: "Sorted", note: "the 64 numbers in ascending order" },
  { value: "random", label: "Random", note: "the same 64 numbers, shuffled" },
  { value: "periodic", label: "Periodic 7:1", note: "seven in, one out, like a loop that exits every 8th time" },
  { value: "alternating", label: "Alternating", note: "in, out, in, out" },
];
const PREDICTORS: { value: Predictor; label: string; note: string }[] = [
  { value: "static", label: "Always taken", note: "a fixed guess" },
  { value: "1bit", label: "1-bit", note: "guess what happened last time" },
  { value: "2bit", label: "2-bit counter", note: "change the guess only after two misses in a row" },
  { value: "history", label: "2-bit + history", note: "one counter for each pattern of the last two outcomes" },
];
const STATES = ["strong no", "weak no", "weak yes", "strong yes"];
const yn = (b: boolean) => (b ? "yes" : "no");

function Bars({ st, dispatch, reduced }: { st: State; dispatch: (a: Action) => void; reduced: boolean }) {
  return (
    <div className={"bp-bars" + (reduced ? "" : " anim")} role="group" aria-label={`${N} values; the line is the threshold ${st.t}. Press a bar to move it across the threshold.`}>
      <span className="bp-t" style={{ bottom: `${(Math.min(st.t, 256) / 256) * 100}%` }} aria-hidden="true"><b>t = {st.t}</b></span>
      {st.values.map((x, i) => {
        const o = st.outcomes[i];
        const cls = !o ? "" : o.predicted === null ? " bl" : o.predicted === o.taken ? " ok" : " miss";
        return (
          <button key={i} className={"bp-bar" + cls + (i === st.pos - 1 ? " cur" : "") + (x >= st.t ? " in" : "")}
            onClick={() => dispatch({ type: "flip", i })}
            aria-label={`value ${i}: ${x}, ${x >= st.t ? "passes" : "fails"} the filter${o ? (o.predicted === null ? "" : o.predicted === o.taken ? ", predicted right" : ", mispredicted") : ""}`}>
            <i style={{ height: `${Math.max(2, (x / 255) * 100)}%` }} />
          </button>
        );
      })}
    </div>
  );
}

function PredictorView({ st }: { st: State }) {
  if (st.code === "branchless") return <p className="muted">No branch on the data, so nothing to predict. The loop computes a mask and adds x or 0, the same instructions every time.</p>;
  if (st.predictor === "static") return <p className="muted">Always guesses yes. Right whenever the value passes; wrong whenever it does not.</p>;
  if (st.predictor === "1bit") return (
    <div className="bp-states">{["last: no", "last: yes"].map((s, k) => <span key={k} className={st.counters[0] === k ? "on" : ""}>{s}</span>)}</div>
  );
  if (st.predictor === "2bit") return (
    <div className="bp-states">{STATES.map((s, k) => <span key={k} className={(st.counters[0] === k ? "on" : "") + (k >= 2 ? " yes" : "")}>{s}</span>)}</div>
  );
  return (
    <div className="bp-hist">
      {st.counters.map((c, h) => (
        <div key={h} className={"bp-hrow" + (st.history === h ? " cur" : "")}>
          <span className="pg-place">last two: {yn(!!(h & 2))}, {yn(!!(h & 1))}</span>
          <div className="bp-states small">{STATES.map((s, k) => <span key={k} className={(c === k ? "on" : "") + (k >= 2 ? " yes" : "")}>{s}</span>)}</div>
        </div>
      ))}
    </div>
  );
}

function lastLine(st: State): string {
  const o = st.outcomes[st.outcomes.length - 1];
  if (!o) return "Press Step, Play or Run. Each bar is one value; the loop adds it if it reaches the threshold line.";
  const q = `x = ${o.x}, x ≥ ${st.t}? ${yn(o.taken)}.`;
  if (o.predicted === null) return `${q} Branchless: the mask is ${o.taken ? "all ones" : "zero"}, so it adds ${o.taken ? o.x : 0}. ${BRANCHLESS} cycles, every time.`;
  if (o.predicted === o.taken) return `${q} The predictor guessed ${yn(o.predicted)}: right. The instructions fetched behind the branch were the right ones. ${BASE} cycles.`;
  return `${q} The predictor guessed ${yn(o.predicted)}: wrong. The core had already started the ${o.predicted ? "add" : "next iteration without the add"} on the guessed path; it threw that work away and refetched. ${BASE + PENALTY} cycles.`;
}

function Result({ st }: { st: State }) {
  const c = compare(st);
  if (!c) return null;
  const ratio = c.slow.cycles / c.fast.cycles;
  const sameSum = c.slow.sum === c.fast.sum;
  let take: string;
  if (c.fast.code === "branchless" && c.slow.code === "branch") take = "Branchless code pays a little on every element and never pays a mispredict. It wins when the branch is unpredictable and loses slightly when it is not.";
  else if (c.slow.mispredicts > N / 4) take = "The work is identical; the guesses are not. A predictable pattern of outcomes (long runs, as after sorting) costs almost nothing, and a random one throws away the pipeline on about half the elements.";
  else take = "Predictors learn patterns, not values. A counter tolerates one surprise; a history predictor learns repeating sequences; nothing learns random outcomes.";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your runs show</span>
      <p>{c.slow.label}: {c.slow.mispredicts} mispredicts, {c.slow.cycles} cycles. {c.fast.label}: {c.fast.mispredicts} mispredicts, {c.fast.cycles} cycles. {sameSum ? "Same sum, " : ""}{ratio.toFixed(1)}× the time. At 3 GHz that is {msPerMillion(c.slow.cycles).toFixed(2)} ms against {msPerMillion(c.fast.cycles).toFixed(2)} ms per million values.</p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function BranchPredictionPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const [tDraft, setTDraft] = useState<number | null>(null);

  useEffect(() => {
    if (!playing) return;
    if (st.pos >= N) { setPlaying(false); return; }
    const t = setTimeout(() => dispatch({ type: "step", n: 1 }), 70);
    return () => clearTimeout(t);
  }, [playing, st.pos, dispatch]);

  const act = (a: Action) => { setPlaying(false); dispatch(a); };
  const play = () => { if (reduced) dispatch({ type: "run" }); else { if (st.pos >= N) dispatch({ type: "step", n: 1 }); setPlaying(true); } };
  const revealed = st.runs.some((r) => r.data === "sorted" && r.code === "branch" && !r.edited && r.t === 128)
    && st.runs.some((r) => r.data === "random" && r.code === "branch" && !r.edited && r.t === 128);
  const perEl = st.pos ? st.cycles / st.pos : 0;

  return (
    <PgFrame title="Guess the branch" onReset={() => { setPlaying(false); dispatch({ type: "reset" }); }}>
      <PgPredict<Prediction>
        question="The loop adds every value of at least 128. Run it on the 64 numbers sorted, then on the same numbers shuffled. How much slower is the shuffled run?"
        options={[{ value: "same", label: "The same: same work" }, { value: "bit", label: "A little, under 1.5×" }, { value: "lots", label: "3× or more" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={revealed}
        answer="lots"
        explain={`About 4× in this model. Sorted, the answer is "no" for a long run and then "yes" for a long run, and the counter is wrong only near the switch. Shuffled, the answer is a coin toss, so the predictor is wrong about half the time and each miss costs ${PENALTY} cycles of thrown-away work.`}
      />

      <div className="pg-req">
        <span className="label">The loop</span>
        <div className="bp-rows">
          <span className="pg-place">Data</span>
          <PgChoice<Data> label="Data" value={st.data} onChange={(v) => act({ type: "data", value: v })} options={DATA} />
          <span className="pg-place">Code</span>
          <PgChoice<Code> label="Code" value={st.code} onChange={(v) => act({ type: "code", value: v })}
            options={[{ value: "branch", label: "if x >= t" }, { value: "branchless", label: "Branchless mask" }]} />
          {st.code === "branch" && <>
            <span className="pg-place">Predictor</span>
            <PgChoice<Predictor> label="Predictor" value={st.predictor} onChange={(v) => act({ type: "predictor", value: v })} options={PREDICTORS} />
          </>}
          <label className="pg-place" htmlFor="bp-t">Threshold {tDraft ?? st.t}</label>
          <input id="bp-t" className="bp-range" type="range" min={0} max={256} value={tDraft ?? st.t}
            onChange={(e) => setTDraft(Number(e.target.value))}
            onPointerUp={() => { if (tDraft !== null) { act({ type: "threshold", value: tDraft }); setTDraft(null); } }}
            onKeyUp={() => { if (tDraft !== null) { act({ type: "threshold", value: tDraft }); setTDraft(null); } }}
            onBlur={() => { if (tDraft !== null) { act({ type: "threshold", value: tDraft }); setTDraft(null); } }} />
        </div>
        <div className="pgc"><div className="pgc-line"><code>{LOOPS[lang][st.code]}</code></div></div>
        <div className="pg-actions">
          <PgButton onClick={() => act({ type: "step", n: 1 })}>Step</PgButton>
          <PgButton primary onClick={play} disabled={playing}>Play</PgButton>
          <PgButton onClick={() => act({ type: "run" })}>Run to end</PgButton>
        </div>
        <p className="muted">Value {st.pos} of {N}. Changing a setting starts the loop again with a fresh predictor. Press a bar to move it across the threshold.</p>
      </div>

      <div className="pg-card">
        <span className="label">The values · teal: guessed right · orange: mispredicted</span>
        <Bars st={st} dispatch={act} reduced={reduced} />
        <p className="bp-last" aria-live="polite">{lastLine(st)}</p>
      </div>

      <div className="pg-sides">
        <div className="pg-side">
          <header><h4>Predictor</h4><span className="pg-status done">{st.code === "branch" ? PREDICTOR_NAMES[st.predictor] : "none needed"}</span></header>
          <PredictorView st={st} />
        </div>
        <div className="pg-side">
          <header><h4>Cycles</h4><span className={"pg-status" + (perEl > 5 ? "" : " done")}>{perEl.toFixed(1)} per value</span></header>
          <div className="bp-tape" aria-label={`Cycle tape: ${st.cycles} cycles so far, one block per value, wider for a mispredict`}>
            {st.outcomes.map((o) => (
              <i key={o.i} style={{ flexGrow: o.cycles }} className={o.predicted === null ? "bl" : o.predicted === o.taken ? "ok" : "miss"} />
            ))}
          </div>
          <dl className="pg-stats bp-stats">
            <div className={st.mispredicts > N / 4 ? "bad" : ""}><dt>Mispredicts</dt><dd>{st.mispredicts}{st.pos ? ` (${Math.round((st.mispredicts / st.pos) * 100)}%)` : ""}</dd></div>
            <div><dt>Cycles</dt><dd>{st.cycles}</dd></div>
            <div><dt>Per million at 3 GHz</dt><dd>{st.pos ? `${msPerMillion((st.cycles / st.pos) * N).toFixed(2)} ms` : "–"}</dd></div>
            <div><dt>Sum</dt><dd>{st.sum}</dd></div>
          </dl>
          <p className="muted">Model: {BASE} cycles per value guessed right, {BASE + PENALTY} when wrong, {BRANCHLESS} branchless.</p>
        </div>
      </div>

      {st.runs.length > 0 && (
        <div className="pg-card">
          <span className="label">Finished runs</span>
          <div className="bp-scroll">
            <table className="bp-table">
              <thead><tr><th>#</th><th>Run</th><th>Mispredicts</th><th>Cycles</th><th>Sum</th></tr></thead>
              <tbody>
                {st.runs.map((r) => (
                  <tr key={r.id}><th scope="row">{r.id}</th><td>{r.label}</td><td className={r.mispredicts > N / 4 ? "bad" : ""}>{r.mispredicts}</td><td>{r.cycles}</td><td>{r.sum}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges: {CHALLENGES.filter((c) => st.done[c.id]).length} of {CHALLENGES.length}</span>
        <ul className="bp-list">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "got" : ""}><span aria-hidden="true">{st.done[c.id] ? "■" : "□"}</span> {c.text}</li>)}
        </ul>
        <p className="muted">Next run: {label(st)}.</p>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Stack Overflow: why is processing a sorted array faster?", href: "https://stackoverflow.com/questions/11227809" },
        { title: "Dan Luu, Branch prediction", href: "https://danluu.com/branch-prediction/" },
        { title: "Matt Godbolt's branch predictor reverse engineering", href: "https://xania.org/201602/bpu-part-one" },
      ]} />

      <style>{CSS}</style>
    </PgFrame>
  );
}

const CSS = `
.bp-rows { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.bp-range { width: 100%; accent-color: var(--accent); }
.bp-bars { position: relative; display: grid; grid-template-columns: repeat(64, minmax(0, 1fr)); gap: 1px; height: 140px; padding: 4px; border: 1px solid var(--line); background: var(--surface); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 12px 12px; }
.bp-bar { position: relative; min-width: 0; height: 100%; padding: 0; border: 0; background: none; cursor: pointer; display: flex; align-items: flex-end; }
.bp-bar i { display: block; width: 100%; background: var(--line); }
.bp-bar.in i { background: var(--ink-2); }
.bp-bar.ok i { background: var(--accent); }
.bp-bar.bl i { background: var(--good); }
.bp-bar.miss i { background: var(--pain); }
.bp-bar.cur { outline: 2px solid var(--ink); outline-offset: -1px; }
.bp-bar:focus-visible { outline: 2px solid var(--accent); }
.bp-bars.anim .bp-bar i { transition: background-color .15s var(--ease), height .2s var(--ease); }
.bp-t { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed var(--pain); pointer-events: none; z-index: 1; }
.bp-t b { position: absolute; right: 4px; top: -14px; font-family: var(--f-code); font-size: .6rem; color: var(--pain); font-weight: 600; background: var(--surface); padding: 0 2px; }
.bp-last { margin: 6px 0 0; font-size: .92rem; }
.bp-states { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 2px; font-family: var(--f-code); font-size: .62rem; text-transform: uppercase; letter-spacing: .04em; }
.bp-states span { border: 1px solid var(--line); padding: 6px 4px; text-align: center; color: var(--ink-2); background: var(--surface); }
.bp-states span.yes { border-style: dashed; }
.bp-states span.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 700; }
.bp-states.small span { padding: 2px; font-size: .55rem; }
.bp-hist { display: grid; gap: 4px; }
.bp-hrow { display: grid; gap: 2px; padding: 2px; border: 1px solid transparent; }
.bp-hrow.cur { border-color: var(--ink); }
.bp-tape { display: flex; height: 18px; border: 1px solid var(--line); background: var(--surface); overflow: hidden; }
.bp-tape i { display: block; min-width: 0; border-right: 1px solid var(--surface); }
.bp-tape i.ok { background: var(--accent); } .bp-tape i.miss { background: var(--pain); } .bp-tape i.bl { background: var(--good); }
.bp-stats { grid-template-columns: 1fr 1fr; }
.bp-scroll { overflow-x: auto; }
.bp-table { width: 100%; border-collapse: collapse; font-size: .85rem; font-variant-numeric: tabular-nums; }
.bp-table th, .bp-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
.bp-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.bp-table td.bad { color: var(--pain); font-weight: 600; }
.bp-list { list-style: none; padding-left: 0 !important; }
.bp-list li.got { color: var(--good); }
@media (max-width: 520px) { .bp-rows { grid-template-columns: 1fr; } .bp-bars { height: 110px; } }
@media (prefers-reduced-motion: reduce) { .bp-bars.anim .bp-bar i { transition: none; } }
`;
