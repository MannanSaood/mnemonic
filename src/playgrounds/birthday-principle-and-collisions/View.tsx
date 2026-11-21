"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, IMPORT_MAX, IMPORT_N, MAX_BITS, MIN_BITS, PRESETS, SIM_MAX_BITS, TRIALS_PER_RUN, TRIAL_MAX_BITS,
  bitsNeeded, canImport, canTrial, expectedPairs, init, meanFirst, n50, pCollide, step, trialMean,
  type Mode, type State,
} from "./model";

const n0 = (x: number) => Math.round(x).toLocaleString("en");
/** Readable big numbers: 77,163 · 2.7 million · 4.3 × 10^9. */
function big(x: number): string {
  if (!Number.isFinite(x)) return "∞";
  if (x < 1e6) return n0(x);
  if (x < 1e9) return `${(x / 1e6).toFixed(x < 1e7 ? 1 : 0)} million`;
  if (x < 1e12) return `${(x / 1e9).toFixed(x < 1e10 ? 1 : 0)} billion`;
  const e = Math.floor(Math.log10(x));
  return `${(x / 10 ** e).toFixed(1)} × 10^${e}`;
}
function prob(p: number): string {
  if (p >= 0.9995) return "≈ 100%";
  if (p >= 0.001) return `${(p * 100).toFixed(p < 0.1 ? 2 : 1)}%`;
  if (p === 0) return "0";
  const e = Math.floor(Math.log10(p));
  return `${(p / 10 ** e).toFixed(1)} × 10^${e}`;
}
const bitsLabel = (b: number) => (Number.isInteger(b) ? String(b) : b.toFixed(1));

function Curve({ st }: { st: State }) {
  const W = 340, H = 150, L = 30, R = 8, T = 10, B = 22;
  const half = Math.log10(n50(st.bits));
  const hi = Math.min(24, Math.max(12, Math.ceil(half + 1.5)));
  const lo = Math.max(0, Math.min(hi - 12, Math.floor(half - 4), Math.floor(Math.log10(st.n))));
  const x = (n: number) => L + ((Math.log10(Math.max(1, n)) - lo) / (hi - lo)) * (W - L - R);
  const y = (p: number) => T + (1 - p) * (H - T - B);
  const pts: string[] = [];
  for (let i = 0; i <= 120; i++) {
    const n = 10 ** (lo + ((hi - lo) * i) / 120);
    pts.push(`${i ? "L" : "M"}${x(n).toFixed(1)},${y(pCollide(n, st.bits)).toFixed(1)}`);
  }
  const sorted = [...st.trials].sort((a, b) => a - b);
  const cdf = sorted.map((c, i) => `${i ? "L" : "M"}${x(c).toFixed(1)},${y(i / sorted.length).toFixed(1)} L${x(c).toFixed(1)},${y((i + 1) / sorted.length).toFixed(1)}`).join(" ");
  const nx = x(st.n), inRange = st.n >= 10 ** lo && st.n <= 10 ** hi;
  const sq = Math.sqrt(2 ** st.bits);
  const ticks = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).filter((e) => (hi - lo > 14 ? e % 3 === 0 : e % 2 === 0));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="bd-curve" role="img"
      aria-label={`Chance of at least one collision against number of IDs for ${bitsLabel(st.bits)}-bit IDs. It passes 50% at about ${big(n50(st.bits))} IDs. Your ${big(st.n)} IDs give ${prob(pCollide(st.n, st.bits))}.`}>
      {[0, 0.5, 1].map((p) => <g key={p}><line x1={L} x2={W - R} y1={y(p)} y2={y(p)} className="bd-grid" /><text x={L - 4} y={y(p) + 3} textAnchor="end" className="bd-ax">{p * 100}%</text></g>)}
      {ticks.map((e) => <text key={e} x={x(10 ** e)} y={H - 6} textAnchor="middle" className="bd-ax">10^{e}</text>)}
      {sq >= 10 ** lo && sq <= 10 ** hi && <><line x1={x(sq)} x2={x(sq)} y1={T} y2={H - B} className="bd-sqrt" /><text x={x(sq) + 3} y={T + 9} className="bd-ax">√d</text></>}
      <path d={pts.join(" ")} className="bd-line" />
      {cdf && <path d={cdf} className="bd-cdf" />}
      {sorted.map((c, i) => <line key={i} x1={x(c)} x2={x(c)} y1={H - B} y2={H - B - 5} className="bd-trial" />)}
      {inRange && <><line x1={nx} x2={nx} y1={T} y2={H - B} className="bd-you" /><circle cx={nx} cy={y(pCollide(st.n, st.bits))} r={3.5} className="bd-dot" /></>}
    </svg>
  );
}

function Result({ st }: { st: State }) {
  const p = pCollide(st.n, st.bits), pairs = expectedPairs(st.n, st.bits);
  const need9 = bitsNeeded(st.n, 1e-9);
  const im = st.imported;
  const sim = im ? ` Your simulated save of ${big(im.n)} files with ${bitsLabel(im.bits)}-bit names hit ${n0(im.collisions)} existing name${im.collisions === 1 ? "" : "s"} (the formula expects ${pairs < 0.01 ? "almost none" : n0(im.expected)}): ${im.mode === "overwrite" ? `${n0(im.lost)} files silently replaced` : `${n0(im.retries)} retries and nothing lost`}.` : "";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your IDs do</span>
      <p>{big(st.n)} IDs drawn from {bitsLabel(st.bits)} bits ({big(2 ** st.bits)} values) make about {big((st.n * (st.n - 1)) / 2)} pairs, so you should expect {pairs < 0.001 ? "essentially no" : pairs < 10 ? pairs.toFixed(2) : n0(pairs)} colliding pairs and a {prob(p)} chance of at least one.{sim}</p>
      <p className="pg-takeaway">Collisions arrive near √d, about {big(n50(st.bits))} IDs here, not near d. To keep {big(st.n)} IDs under a one-in-a-billion chance you need {need9} random bits; doubling the number of IDs costs two more bits. 122 or 128 random bits cover any real system, and insert-if-absent turns the rare collision into a retry.</p>
    </div>
  );
}

export default function BirthdayPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const p = pCollide(st.n, st.bits);
  const preset = PRESETS.find((x) => x.bits === st.bits)?.id ?? "";
  const mean = trialMean(st);
  const trialOk = canTrial(st.bits), importOk = canImport(st.n, st.bits);

  return (
    <PgFrame title="Random IDs, and when two of them match" onReset={() => dispatch({ type: "reset" })}>
      <PgPredict
        question="An upload service names files with 8 random hex characters: 32 bits, 4.3 billion names. How many files until two sharing a name is more likely than not?"
        options={[{ value: "2b", label: "About 2 billion" }, { value: "65m", label: "About 65 million" }, { value: "77k", label: "About 77,000" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.ranSim}
        answer="77k"
        explain={<>About 77,000, the square root of 4.3 billion times 1.18. A collision needs only some pair to match, and 77,000 files make about 3 billion pairs. Each pair matches with chance 1 in 4.3 billion, so together they are more likely than not to produce one.</>}
      />

      <div className="pg-req">
        <span className="label">ID size · {bitsLabel(st.bits)} random bits · {big(2 ** st.bits)} possible IDs</span>
        <PgChoice<string> label="ID format" value={preset} onChange={(v) => dispatch({ type: "preset", id: v })}
          options={PRESETS.map((x) => ({ value: x.id, label: x.label, note: x.note }))} />
        <input className="bd-range" type="range" min={MIN_BITS} max={MAX_BITS} step={1} value={Math.round(st.bits)}
          aria-label="Random bits per ID" onChange={(e) => dispatch({ type: "bits", bits: Number(e.target.value) })} />
        <span className="label">Number of IDs · {n0(st.n)}</span>
        <input className="bd-range" type="range" min={1} max={15} step={0.05} value={Math.log10(st.n)}
          aria-label="Number of IDs, logarithmic" onChange={(e) => dispatch({ type: "n", n: 10 ** Number(e.target.value) })} />
        <div className="pg-actions">
          <PgButton onClick={() => dispatch({ type: "n", n: Math.round(n50(st.bits)) })}>The 50% point</PgButton>
          <PgButton onClick={() => dispatch({ type: "n", n: IMPORT_N })}>2 million files</PgButton>
          <PgButton onClick={() => dispatch({ type: "n", n: 1e9 })}>1 billion</PgButton>
        </div>
      </div>

      <dl className="pg-stats bd-stats">
        <div className={p > 0.01 ? "bad" : ""}><dt>P(any collision)</dt><dd>{prob(p)}</dd></div>
        <div className={expectedPairs(st.n, st.bits) >= 1 ? "bad" : ""}><dt>Expected pairs</dt><dd>{expectedPairs(st.n, st.bits) < 0.001 ? prob(expectedPairs(st.n, st.bits)) : expectedPairs(st.n, st.bits) < 100 ? expectedPairs(st.n, st.bits).toFixed(2) : big(expectedPairs(st.n, st.bits))}</dd></div>
        <div><dt>50% at</dt><dd>{big(n50(st.bits))} IDs</dd></div>
        <div><dt>Bits for 1 in 10^9</dt><dd>{bitsNeeded(st.n, 1e-9)}</dd></div>
      </dl>

      <div className="pg-card">
        <span className="label">Chance of a collision by number of IDs · line: 1 − e^(−n²/2d) · steps: your trials · dot: your n</span>
        <Curve st={st} />
      </div>

      <div className="pg-sides">
        <div className="pg-side">
          <header><h4>Draw until two match</h4><span className={"pg-status" + (st.trials.length ? " done" : "")}>{st.trials.length ? `${st.trials.length} trials` : "not run"}</span></header>
          <PgButton primary onClick={() => dispatch({ type: "trials" })} disabled={!trialOk}>Run {TRIALS_PER_RUN} trials</PgButton>
          {trialOk ? (
            <dl className="pg-stats bd-two">
              <div><dt>Average first match</dt><dd>{st.trials.length ? n0(mean) : "-"}</dd></div>
              <div><dt>Theory √(πd/2)</dt><dd>{n0(meanFirst(st.bits))}</dd></div>
              <div><dt>Earliest</dt><dd>{st.trials.length ? n0(Math.min(...st.trials)) : "-"}</dd></div>
              <div><dt>Latest</dt><dd>{st.trials.length ? n0(Math.max(...st.trials)) : "-"}</dd></div>
            </dl>
          ) : <p className="muted">At {bitsLabel(st.bits)} bits one trial would draw about {big(meanFirst(st.bits))} IDs. Simulation stops at {TRIAL_MAX_BITS} bits; the formula carries on.</p>}
        </div>
        <div className="pg-side">
          <header><h4>Break it: save {big(st.n)} files</h4><span className={"pg-status" + (st.imported && st.imported.lost === 0 ? " done" : "")}>{st.imported ? `${n0(st.imported.lost)} lost` : "not run"}</span></header>
          <PgChoice<Mode> label="When a name is taken" value={st.mode} onChange={(v) => dispatch({ type: "mode", mode: v })}
            options={[{ value: "overwrite", label: "Plain put: overwrite" }, { value: "retry", label: "Insert-if-absent: retry" }]} />
          <PgButton primary onClick={() => dispatch({ type: "import" })} disabled={!importOk}>Save the files</PgButton>
          {!importOk && <p className="muted">{st.n > IMPORT_MAX ? `Simulation stops at ${big(IMPORT_MAX)} files.` : `Simulation stops at ${SIM_MAX_BITS} bits.`} Use the formula above.</p>}
          {st.imported && (
            <dl className="pg-stats bd-two">
              <div className={st.imported.collisions ? "bad" : ""}><dt>Names hit twice</dt><dd>{n0(st.imported.collisions)}</dd></div>
              <div><dt>Formula expects</dt><dd>{st.imported.expected < 0.01 ? "≈ 0" : st.imported.expected.toFixed(1)}</dd></div>
              <div className={st.imported.lost ? "bad" : ""}><dt>Files lost</dt><dd>{n0(st.imported.lost)}</dd></div>
              <div><dt>Retries</dt><dd>{n0(st.imported.retries)}</dd></div>
            </dl>
          )}
        </div>
      </div>

      <div className="pg-req">
        <span className="label">Challenges: {CHALLENGES.filter((c) => st.done[c.id]).length} of {CHALLENGES.length}</span>
        <ul className="bd-list">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "got" : ""}><span aria-hidden="true">{st.done[c.id] ? "■" : "□"}</span> {c.text}</li>)}
        </ul>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "the hash collision probability calculator", href: "https://stevenli-phoenix.github.io/toolbox/hashcollision.html" },
        { title: "Wikipedia's birthday attack table", href: "https://en.wikipedia.org/wiki/Birthday_attack" },
        { title: "Lehman, Leighton and Meyer, Mathematics for Computer Science", href: "https://ocw.mit.edu/courses/6-042j-mathematics-for-computer-science-spring-2015/" },
      ]} />

      <style>{CSS}</style>
    </PgFrame>
  );
}

const CSS = `
.bd-range { width: 100%; accent-color: var(--accent); }
.bd-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.bd-two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.bd-curve { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.bd-grid { stroke: var(--grid); stroke-width: 1; }
.bd-ax { font-family: var(--f-code); font-size: 7.5px; fill: var(--ink-2); }
.bd-line { fill: none; stroke: var(--accent); stroke-width: 2; }
.bd-cdf { fill: none; stroke: var(--pain); stroke-width: 1.3; }
.bd-trial { stroke: var(--pain); stroke-width: 1; }
.bd-sqrt { stroke: var(--ink-2); stroke-dasharray: 3 3; }
.bd-you { stroke: var(--ink); stroke-width: 1; }
.bd-dot { fill: var(--ink); }
.bd-list { list-style: none; padding-left: 0 !important; }
.bd-list li.got { color: var(--good); }
@media (max-width: 560px) { .bd-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;
