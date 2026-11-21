"use client";
import { useEffect, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BROWSE_PER_S, CHALLENGES, CHECKOUT_PER_S, DB_CAPACITY, DB_CAPACITY_SLOW, PRESETS, RETRY_NAME, SECONDS, SLOWS, SLOW_START_S, TIERS, TIER_SHORT, WORKERS,
  challengeDone, describe, init, shownRun, step,
  type Config, type RetryMode, type Run, type Second, type State,
} from "./model";

const n = (k: number) => Math.round(k).toLocaleString("en");
const W = 600, PAD = 40;
const xs = (t: number) => PAD + (t / SECONDS) * (W - PAD - 6);
const BW = (W - PAD - 6) / SECONDS;
const slowAt = (c: Config, t: number) => c.slow > 0 && t >= SLOW_START_S && t < SLOW_START_S + c.slow;

/** The chain at one second: each service's workers, queue and the calls arriving at it. */
function Chain({ run, s }: { run: Run; s: Second }) {
  const H = 150, bw = 112, gap = (W - 4 * bw - 20) / 3;
  const bx = (i: number) => 10 + i * (bw + gap);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cf-chain" role="img"
      aria-label={`Second ${s.t}: ${TIERS.map((t, i) => `${t} ${s.busy[i]} of ${WORKERS[i]} workers busy, ${s.queue[i]} queued`).join("; ")}.`}>
      {TIERS.map((name, i) => {
        const u = s.busy[i] / WORKERS[i];
        const full = s.busy[i] >= WORKERS[i];
        const arriving = s.first[i] + s.retries[i];
        return (
          <g key={name}>
            {i > 0 && (
              <g className="cf-edge">
                <line x1={bx(i - 1) + bw} x2={bx(i)} y1={62} y2={62} />
                <text x={bx(i) - gap / 2} y={52} textAnchor="middle">{n(arriving)}/s</text>
                {s.retries[i] > 0 && <text x={bx(i) - gap / 2} y={80} textAnchor="middle" className="cf-retry">{n(s.retries[i])} retries</text>}
              </g>
            )}
            <rect x={bx(i)} y={20} width={bw} height={86} className={"cf-box" + (full ? " full" : "") + (i === 3 && slowAt(run.config, s.t) ? " slow" : "")} />
            <text x={bx(i) + 6} y={34} className="cf-name">{name}{i === 3 && slowAt(run.config, s.t) ? " · slow" : ""}</text>
            <rect x={bx(i) + 6} y={44} width={bw - 12} height={14} className="cf-track" />
            <rect x={bx(i) + 6} y={44} width={(bw - 12) * Math.min(1, u)} height={14} className={"cf-fill" + (full ? " full" : "")} />
            <text x={bx(i) + 6} y={72} className="cf-small">{s.busy[i]}/{WORKERS[i]} workers</text>
            <text x={bx(i) + 6} y={86} className={"cf-small" + (s.queue[i] > WORKERS[i] ? " bad" : "")}>{n(s.queue[i])} queued</text>
            {(s.shed[i] > 0 || s.expired[i] > 0 || s.wasted[i] > 0) && (
              <text x={bx(i) + 6} y={100} className="cf-small">{[s.shed[i] ? `${n(s.shed[i])} shed` : "", s.expired[i] ? `${n(s.expired[i])} expired` : "", s.wasted[i] ? `${n(s.wasted[i])} wasted` : ""].filter(Boolean).join(" · ")}</text>
            )}
          </g>
        );
      })}
      <g className="cf-users">
        <text x={10} y={124}>Browse (frontend only): {s.browseOk} ok · <tspan className={s.browseFail ? "bad" : ""}>{s.browseFail} failed</tspan></text>
        <text x={10} y={140}>Checkout (all four): {s.checkoutOk} ok · <tspan className={s.checkoutFail ? "bad" : ""}>{s.checkoutFail} failed</tspan></text>
      </g>
    </svg>
  );
}

/** Rows: services, columns: seconds, shade: share of workers busy. The cascade climbs the rows. */
function Heat({ run, at, onAt }: { run: Run; at: number; onAt: (t: number) => void }) {
  return (
    <div className="cf-heat" role="group" aria-label="Workers busy per service per second. Pick a second to show it in the chain.">
      {[...TIERS.keys()].map((i) => (
        <div key={i} className="cf-row">
          <span className="cf-rk">{TIER_SHORT[i]}</span>
          <div className="cf-cells">
            {run.seconds.map((s) => {
              const u = s.busy[i] / WORKERS[i];
              return (
                <button key={s.t} className={"cf-cell" + (s.t === at ? " on" : "") + (u >= 1 ? " full" : "")} style={{ ["--u" as string]: String(Math.min(1, u)) }}
                  onClick={() => onAt(s.t)} aria-label={`${TIERS[i]}, second ${s.t}: ${s.busy[i]} of ${WORKERS[i]} workers busy`} title={`${TIERS[i]} · ${s.t}s · ${s.busy[i]}/${WORKERS[i]} busy · ${s.queue[i]} queued`} />
              );
            })}
          </div>
        </div>
      ))}
      <div className="cf-row">
        <span className="cf-rk">users</span>
        <div className="cf-cells">
          {run.seconds.map((s) => {
            const bad = s.browseFail + s.checkoutFail;
            return <span key={s.t} className={"cf-ucell" + (s.browseFail ? " browse" : bad ? " some" : "")} title={`${s.t}s: ${s.browseFail} browse and ${s.checkoutFail} checkout failures`} />;
          })}
        </div>
      </div>
      <div className="cf-row cf-axis" aria-hidden="true"><span className="cf-rk" /><div className="cf-cells">{run.seconds.map((s) => <span key={s.t}>{s.t % 10 === 0 ? `${s.t}s` : ""}</span>)}</div></div>
    </div>
  );
}

function DbChart({ run, at }: { run: Run; at: number }) {
  const H = 130, TOP = 14, BOT = H - 16;
  const max = Math.max(250, Math.ceil(run.summary.peakDb / 100) * 100);
  const y = (v: number) => BOT - (Math.min(v, max) / max) * (BOT - TOP);
  const cap = run.seconds.map((s) => { const c = slowAt(run.config, s.t) ? DB_CAPACITY_SLOW : DB_CAPACITY; return `${xs(s.t)},${y(c)} ${xs(s.t + 1)},${y(c)}`; }).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cf-chart" role="img" aria-label={`Calls reaching the database per second; peak ${n(run.summary.peakDb)}, ${run.summary.amplification.toFixed(1)} times the checkout traffic. Capacity ${DB_CAPACITY} normally, ${Math.round(DB_CAPACITY_SLOW)} while slow.`}>
      {run.config.slow > 0 && <rect x={xs(SLOW_START_S)} y={TOP - 6} width={xs(SLOW_START_S + run.config.slow) - xs(SLOW_START_S)} height={BOT - TOP + 6} className="cf-band" />}
      <rect x={xs(at)} y={TOP - 6} width={BW} height={BOT - TOP + 6} className="cf-now" />
      {run.seconds.map((s) => (
        <g key={s.t}>
          <rect x={xs(s.t) + 1} y={y(s.first[3])} width={BW - 2} height={BOT - y(s.first[3])} className="cf-first" />
          <rect x={xs(s.t) + 1} y={y(s.first[3] + s.retries[3])} width={BW - 2} height={y(s.first[3]) - y(s.first[3] + s.retries[3])} className="cf-retries" />
          {s.wasted[3] > 0 && <rect x={xs(s.t) + BW / 2 - 1} y={y(s.wasted[3])} width={2} height={BOT - y(s.wasted[3])} className="cf-wasted" />}
        </g>
      ))}
      <polyline points={cap} className="cf-cap" />
      <g className="cf-ax">
        <text x={PAD - 4} y={TOP + 4} textAnchor="end">{max}</text>
        <text x={PAD - 4} y={BOT} textAnchor="end">0</text>
        <text x={W - 8} y={TOP + 2} textAnchor="end">DB calls/s</text>
        {[0, 10, 20, 30, 40].map((t) => <text key={t} x={xs(t)} y={H - 3} textAnchor="middle">{t}s</text>)}
      </g>
    </svg>
  );
}

function Result({ run }: { run: Run }) {
  const m = run.summary, c = run.config;
  const sat = m.saturatedAt;
  const order = [3, 2, 1, 0].filter((i) => sat[i] !== null).map((i) => `${TIERS[i].toLowerCase()} at ${sat[i]} s`);
  let take: string;
  if (!c.slow) take = "Nothing slowed down, so every setting looks fine: each service uses a few percent of its workers. Slow the database down and run again.";
  else if (m.browseFail > 0 && m.recovery === null)
    take = `A cascading failure. The database could only serve ${Math.round(DB_CAPACITY_SLOW)} calls a second, so every caller above it held a worker while it waited, and the pools filled from the bottom up: ${order.join(", ")}. Then the frontend had no workers for browse pages, which never touch the database. Retries at three layers sent the database up to ${m.amplification.toFixed(1)}× the checkout traffic, and after it recovered it spent its capacity on ${n(m.dbWasted)} calls nobody was waiting for. The cause was gone; the outage stayed.`;
  else if (m.browseFail > 0)
    take = `The slowdown spread up the chain (${order.join(", ")}) until the frontend turned away browse pages that never touch the database. Every waiting caller holds a worker.`;
  else if (m.amplification > 10)
    take = `Load shedding kept every queue short, so callers failed fast and browse pages were safe. But each rejection was retried at every layer: the database saw ${m.amplification.toFixed(0)}× the checkout traffic, 3 × 3 × 3 attempts per checkout. Cheap rejections hide it here; if rejecting cost the database real work, this would be the next outage.`;
  else if (m.recovery !== null && m.recovery > 5)
    take = `Browse pages survived, but checkout recovered ${m.recovery} s after the database did, because it first worked through ${n(m.dbWasted)} calls whose callers had given up. Deadlines that travel with the request would have dropped them.`;
  else
    take = `Contained. The database was overloaded for ${c.slow} s and checkout degraded, but ${c.shedding ? "short queues failed calls fast, " : ""}${c.deadlines ? "deadlines dropped work nobody was waiting for, " : ""}${c.retries === "budget" ? "the retry budget kept retries near 10% of traffic, " : c.retries === "one" ? "retrying at one layer kept the multiplication down, " : ""}so the frontend's workers stayed free and users were served normally ${m.recovery ?? 0} s after the database recovered.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What this slowdown cost</span>
      <p>
        With {describe(c)}{c.slow ? ` and a ${c.slow}-second database slowdown` : ""}: {n(m.browseFail)} browse errors, {n(m.checkoutOk)} checkouts completed and {n(m.checkoutFail)} failed.
        The database peaked at {n(m.peakDb)} calls a second ({m.amplification.toFixed(1)}× checkout traffic) and finished {n(m.dbWasted)} for callers who had left.
        {c.slow ? (m.recovery === null ? " Users were still not served normally when the run ended." : ` Users were served normally ${m.recovery} s after the database recovered.`) : ""}
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function CascadingFailuresPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const c = st.config;
  const run = shownRun(st);
  const set = (patch: Partial<Config>) => dispatch({ type: "set", patch });
  const naive = st.runs.find((r) => r.config.slow >= 5 && r.config.retries === "every" && !r.config.deadlines && !r.config.shedding);

  useEffect(() => {
    if (!playing || !run) return;
    if (st.at >= SECONDS - 1) { setPlaying(false); return; }
    const id = setTimeout(() => dispatch({ type: "at", t: st.at + 1 }), 280);
    return () => clearTimeout(id);
  }, [playing, st.at, run, dispatch]);

  const play = () => { if (st.at >= SECONDS - 1) dispatch({ type: "at", t: 0 }); setPlaying(true); };

  return (
    <PgFrame title="Four services, one slow database" onReset={() => { setPlaying(false); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <PgPredict
        question="The database slows down for 10 seconds. Checkout calls retry up to 3 times at every layer. What happens to browse pages, which only need the frontend?"
        options={[{ value: "fine", label: "Unaffected" }, { value: "slow", label: "Slower, but they work" }, { value: "fail", label: "They fail too" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={!!naive}
        answer={naive && naive.summary.browseFail === 0 ? "slow" : "fail"}
        explain="They fail too, and keep failing after the database recovers. Each checkout holds a frontend worker while it waits on checkout, which waits on inventory, which waits on the database. The pools fill from the bottom up until the frontend has no worker left for anything."
      />

      <div className="pg-card">
        <span className="label">Frontend → Checkout → Inventory → Database</span>
        <div className="cf-presets pg-actions">
          {PRESETS.map((p) => <PgButton key={p.id} onClick={() => dispatch({ type: "preset", id: p.id })}>{p.label}</PgButton>)}
        </div>
        <div className="cf-controls">
          <span className="cf-k">Retries</span>
          <PgChoice<RetryMode> label="Retries" value={c.retries} onChange={(v) => set({ retries: v })}
            options={(Object.keys(RETRY_NAME) as RetryMode[]).map((r) => ({ value: r, label: RETRY_NAME[r], note: r === "one" ? "Only inventory retries its database calls" : r === "budget" ? "Retries may not exceed 10% of first attempts, per caller" : "Frontend, checkout and inventory each try up to 3 times" }))} />
          <span className="cf-k">Deadlines</span>
          <PgChoice<string> label="Deadline propagation" value={c.deadlines ? "on" : "off"} onChange={(v) => set({ deadlines: v === "on" })}
            options={[{ value: "off", label: "Off" }, { value: "on", label: "Propagate" }]} />
          <span className="cf-k">Shedding</span>
          <PgChoice<string> label="Load shedding" value={c.shedding ? "on" : "off"} onChange={(v) => set({ shedding: v === "on" })}
            options={[{ value: "off", label: "Off" }, { value: "on", label: "Short queues" }]} />
          <span className="cf-k cf-break">Break it</span>
          <PgChoice<string> label="Database slowdown" value={String(c.slow)} onChange={(v) => set({ slow: Number(v) })}
            options={SLOWS.map((s) => ({ value: String(s), label: s ? `DB slow ${s} s` : "No slowdown" }))} />
        </div>
        <p className="cf-note">Users: {BROWSE_PER_S} browse and {CHECKOUT_PER_S} checkout a second; they give up after 3 s. Workers: {WORKERS.join(" / ")}. The database does {DB_CAPACITY} calls a second, {Math.round(DB_CAPACITY_SLOW)} while slow (from {SLOW_START_S} s). Timeouts per attempt: 2 s, 1 s, 0.5 s down the chain.</p>
        <div className="pg-actions">
          <PgButton primary onClick={() => { setPlaying(false); dispatch({ type: "run" }); }}>Run 40 seconds</PgButton>
        </div>
      </div>

      {run ? (
        <div className="pg-card">
          <span className="label">Run {run.id} · {describe(run.config)} · second {st.at}</span>
          <Chain run={run} s={run.seconds[st.at]} />
          <div className="cf-scrub">
            <PgButton onClick={() => (playing ? setPlaying(false) : play())}>{playing ? "Pause" : "Play"}</PgButton>
            <input type="range" min={0} max={SECONDS - 1} value={st.at} onChange={(e) => { setPlaying(false); dispatch({ type: "at", t: Number(e.target.value) }); }} aria-label="Second to show" />
          </div>
          <span className="cf-legend"><i className="cf-lg-lo" />idle <i className="cf-lg-hi" />busy <i className="cf-lg-full" />every worker busy · bottom row: <i className="cf-lg-some" />checkout errors <i className="cf-lg-browse" />browse errors</span>
          <Heat run={run} at={st.at} onAt={(t) => { setPlaying(false); dispatch({ type: "at", t }); }} />
          <span className="cf-legend"><i className="cf-lg-first" />first calls <i className="cf-lg-retry" />retries <i className="cf-lg-wasted" />finished for nobody <i className="cf-lg-cap" />capacity</span>
          <DbChart run={run} at={st.at} />
          <dl className="pg-stats">
            <div className={run.summary.browseFail ? "bad" : ""}><dt>Browse errors</dt><dd>{n(run.summary.browseFail)}</dd></div>
            <div><dt>Checkouts ok</dt><dd>{n(run.summary.checkoutOk)}</dd></div>
            <div className={run.summary.checkoutFail ? "bad" : ""}><dt>Checkouts failed</dt><dd>{n(run.summary.checkoutFail)}</dd></div>
            <div className={run.summary.recovery === null ? "bad" : ""}><dt>Recovery</dt><dd>{!run.config.slow ? "n/a" : run.summary.recovery === null ? "not yet" : `${run.summary.recovery} s`}</dd></div>
            <div className={run.summary.amplification > 1.5 ? "bad" : ""}><dt>DB load ÷ users</dt><dd>{run.summary.amplification.toFixed(1)}×</dd></div>
            <div className={run.summary.dbWasted ? "bad" : ""}><dt>Wasted DB work</dt><dd>{n(run.summary.dbWasted)}</dd></div>
            <div className={run.summary.saturatedAt[0] !== null ? "bad" : ""}><dt>Frontend full</dt><dd>{run.summary.saturatedAt[0] === null ? "never" : `at ${run.summary.saturatedAt[0]} s`}</dd></div>
            <div><dt>Pools that filled</dt><dd>{run.summary.saturatedAt.filter((x) => x !== null).length} of 4</dd></div>
          </dl>
        </div>
      ) : (
        <div className="pg-card"><p className="pg-empty">Make your prediction, then press Run 40 seconds. The defaults are a common starting point: three tries at every layer, no deadlines, and queues that grow as long as they need to.</p></div>
      )}

      {st.runs.length > 1 && (
        <div className="pg-card">
          <span className="label">Your runs · same users, compare the defences</span>
          <div className="cf-runs" role="table" aria-label="Your runs">
            <div role="row" className="cf-tr head"><span role="columnheader">Defences</span><span role="columnheader">Slowdown</span><span role="columnheader">Browse errors</span><span role="columnheader">DB load</span><span role="columnheader">Recovery</span></div>
            {st.runs.map((r) => (
              <button key={r.id} role="row" className={"cf-tr" + (r.id === st.shown ? " on" : "")} onClick={() => dispatch({ type: "show", id: r.id })}>
                <span role="cell">{r.id}. {describe(r.config)}</span>
                <span role="cell">{r.config.slow ? `${r.config.slow} s` : "none"}</span>
                <span role="cell">{n(r.summary.browseFail)}</span>
                <span role="cell">{r.summary.amplification.toFixed(1)}×</span>
                <span role="cell">{!r.config.slow ? "n/a" : r.summary.recovery === null ? "not yet" : `${r.summary.recovery} s`}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="cf-ch">
          {CHALLENGES.map((ch) => <li key={ch.id} className={challengeDone(st, ch.id) ? "done" : ""}>{challengeDone(st, ch.id) ? "✓ " : ""}{ch.text}</li>)}
        </ol>
      </div>

      {run && <Result run={run} />}

      <PgSources links={[
        { title: "the SRE book's chapter on addressing cascading failures", href: "https://sre.google/sre-book/addressing-cascading-failures/" },
        { title: "Marc Brooker on retries, token buckets and circuit breakers", href: "https://brooker.co.za/blog/2022/02/28/retries.html" },
        { title: "Fred Hebert's Queues Don't Fix Overload", href: "https://ferd.ca/queues-don-t-fix-overload.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.cf-presets { gap: 6px; }
.cf-controls { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.cf-controls .pg-choice { justify-self: start; }
.cf-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.cf-k.cf-break { color: var(--pain); }
.cf-note { margin: 0; font-size: .85rem; color: var(--ink-2); }
.cf-chain, .cf-chart { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.cf-box { fill: var(--surface); stroke: var(--line); stroke-width: 1.4; transition: fill .25s, stroke .25s; }
.cf-box.full { stroke: var(--pain); fill: var(--pain-bg); }
.cf-box.slow { stroke-dasharray: 5 3; stroke: var(--pain); }
.cf-name { font-family: var(--f-code); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; fill: var(--ink); }
.cf-small { font-family: var(--f-code); font-size: 9.5px; fill: var(--ink-2); }
.cf-small.bad, .cf-users .bad { fill: var(--pain); font-weight: 700; }
.cf-track { fill: var(--surface-2); stroke: var(--line); }
.cf-fill { fill: var(--accent); transition: width .25s var(--ease); }
.cf-fill.full { fill: var(--pain); }
.cf-edge line { stroke: var(--ink-2); stroke-width: 1.4; marker-end: none; }
.cf-edge text { font-family: var(--f-code); font-size: 9.5px; fill: var(--ink); }
.cf-edge text.cf-retry { fill: var(--pain); }
.cf-users text { font-size: 11px; fill: var(--ink); }
.cf-scrub { display: flex; gap: 10px; align-items: center; }
.cf-scrub input { flex: 1; accent-color: var(--accent); }
.cf-heat { display: grid; gap: 2px; }
.cf-row { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 4px; align-items: center; }
.cf-rk { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); text-align: right; }
.cf-cells { display: grid; grid-template-columns: repeat(40, minmax(0, 1fr)); gap: 1px; }
.cf-cell { height: 18px; border: 0; padding: 0; cursor: pointer; background: color-mix(in srgb, var(--accent) calc(var(--u) * 100%), var(--surface-2)); }
.cf-cell.full { background: var(--pain); }
.cf-cell.on { outline: 2px solid var(--ink); outline-offset: -1px; }
.cf-ucell { height: 8px; background: var(--good); }
.cf-ucell.some { background: var(--accent); }
.cf-ucell.browse { background: var(--pain); }
.cf-axis .cf-cells span { font-family: var(--f-code); font-size: 9px; color: var(--ink-2); white-space: nowrap; }
.cf-band { fill: var(--pain-bg); }
.cf-now { fill: var(--hl); }
.cf-first { fill: var(--accent); }
.cf-retries { fill: var(--pain); }
.cf-wasted { fill: var(--ink); }
.cf-cap { fill: none; stroke: var(--ink); stroke-width: 1.4; stroke-dasharray: 5 3; }
.cf-ax text { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.cf-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-family: var(--f-code); font-size: .62rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.cf-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 3px; vertical-align: -1px; }
.cf-lg-lo { background: var(--surface-2); border: 1px solid var(--line); } .cf-lg-hi, .cf-lg-first { background: var(--accent); } .cf-lg-full, .cf-lg-retry, .cf-lg-browse { background: var(--pain); }
.cf-lg-some { background: var(--accent); } .cf-lg-wasted { background: var(--ink); } .cf-lg-cap { border-top: 2px dashed var(--ink); height: 0 !important; }
.cf-runs { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); font-size: .82rem; }
.cf-tr { display: grid; grid-template-columns: minmax(0, 2.4fr) repeat(4, minmax(0, 1fr)); gap: 1px; padding: 0; border: 0; background: var(--line); text-align: left; font: inherit; color: inherit; }
.cf-tr > span { background: var(--surface); padding: 4px 6px; font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
.cf-tr.head > span { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.cf-tr.on > span { background: var(--hl); }
button.cf-tr { cursor: pointer; }
.cf-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.cf-ch li.done { color: var(--good); }
@media (max-width: 560px) { .cf-controls { grid-template-columns: 1fr; } .cf-tr { font-size: .72rem; } .cf-cell { height: 14px; } }
@media (prefers-reduced-motion: reduce) { .cf-box, .cf-fill { transition: none; } }
`;
