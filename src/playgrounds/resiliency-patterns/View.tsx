"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CAP_NORMAL, CHALLENGES, OUTAGES, OUTAGE_START, POOL, PRESETS, RETRIES, SECONDS, TIMEOUTS, USERS_PER_S,
  challengeDone, describe, init, shownRun, step,
  type BackoffOpt, type Config, type RetryOpt, type Run, type TimeoutOpt,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k.toLocaleString("en")} ${k === 1 ? one : many}`;
const W = 600, PAD = 28;
const x = (t: number) => PAD + (t / SECONDS) * (W - PAD - 6);
const BW = (W - PAD - 6) / SECONDS - 1;

function OutageBand({ c, h }: { c: Config; h: number }) {
  if (!c.outage) return null;
  return (
    <g>
      <rect x={x(OUTAGE_START)} y={4} width={x(OUTAGE_START + c.outage) - x(OUTAGE_START)} height={h - 8} className="res-band" />
      <text x={x(OUTAGE_START) + 3} y={14} className="res-tiny">slowdown</text>
    </g>
  );
}

function Axis({ h, max, unit }: { h: number; max: number; unit: string }) {
  const ticks = [0, 15, 30, 45, 60];
  return (
    <g className="res-axis">
      <line x1={PAD} y1={h - 14} x2={W - 6} y2={h - 14} />
      {ticks.map((t) => <text key={t} x={x(t)} y={h - 3} textAnchor="middle">{t}s</text>)}
      <text x={PAD - 3} y={12} textAnchor="end">{max}</text>
      <text x={PAD - 3} y={h - 16} textAnchor="end">0</text>
      <text x={W - 8} y={12} textAnchor="end">{unit}</text>
    </g>
  );
}

function Sweep({ id, h, reduced }: { id: number; h: number; reduced: boolean }) {
  if (reduced) return null;
  return <rect key={id} x={PAD} y={0} width={W - PAD} height={h - 14} className="res-sweep" />;
}

function LoadChart({ run, reduced }: { run: Run; reduced: boolean }) {
  const h = 150, top = 20, bottom = h - 14;
  const max = Math.max(200, Math.ceil(run.summary.peakLoad / 100) * 100);
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  const cap = run.seconds.map((s) => `${x(s.t)},${y(s.capacity)} ${x(s.t + 1)},${y(s.capacity)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="res-chart" role="img"
      aria-label={`Calls reaching the dependency per second. Peak ${run.summary.peakLoad}, normal ${USERS_PER_S}, capacity ${CAP_NORMAL}.`}>
      <OutageBand c={run.config} h={h} />
      {run.seconds.map((s) => (
        <g key={s.t}>
          <rect x={x(s.t)} y={y(s.firstAttempts)} width={BW} height={bottom - y(s.firstAttempts)} className="res-first" />
          <rect x={x(s.t)} y={y(s.firstAttempts + s.retries)} width={BW} height={y(s.firstAttempts) - y(s.firstAttempts + s.retries)} className="res-retry" />
        </g>
      ))}
      <polyline points={cap} className="res-cap" />
      <Axis h={h} max={max} unit="calls/s" />
      <Sweep id={run.id} h={h} reduced={reduced} />
    </svg>
  );
}

function UserChart({ run, reduced }: { run: Run; reduced: boolean }) {
  const h = 130, top = 20, bottom = h - 14;
  const max = Math.max(100, ...run.seconds.map((s) => Math.ceil(s.ok + s.degraded + s.failed + s.rejected)));
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="res-chart" role="img"
      aria-label={`What users got per second: ${run.summary.ok} answered, ${run.summary.degraded} fallback, ${run.summary.failed + run.summary.rejected} errors.`}>
      <OutageBand c={run.config} h={h} />
      {run.seconds.map((s) => {
        let acc = 0;
        return (
          <g key={s.t}>
            {([["ok", s.ok], ["degraded", s.degraded], ["failed", s.failed], ["rejected", s.rejected]] as const).map(([k, v]) => {
              const y0 = y(acc), y1 = y(acc + v);
              acc += v;
              return v > 0 ? <rect key={k} x={x(s.t)} y={y1} width={BW} height={y0 - y1} className={`res-${k}`} /> : null;
            })}
          </g>
        );
      })}
      <Axis h={h} max={max} unit="users/s" />
      <Sweep id={run.id} h={h} reduced={reduced} />
    </svg>
  );
}

function PoolChart({ run, reduced }: { run: Run; reduced: boolean }) {
  const h = 92, top = 16, bottom = h - 26;
  const y = (v: number) => bottom - (Math.min(v, POOL) / POOL) * (bottom - top);
  const line = run.seconds.map((s) => `${x(s.t + 0.5)},${y(s.inFlight)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="res-chart" role="img"
      aria-label={`API workers busy, peak ${run.summary.peakInFlight} of ${POOL}. Breaker ${run.config.breaker ? "on" : "off"}.`}>
      <line x1={PAD} y1={y(POOL)} x2={W - 6} y2={y(POOL)} className="res-cap" />
      <text x={W - 8} y={y(POOL) - 3} textAnchor="end" className="res-tiny">pool full ({POOL})</text>
      <polyline points={line} className="res-pool" />
      {run.config.breaker && run.seconds.map((s) => (
        <rect key={s.t} x={x(s.t)} y={h - 22} width={BW} height={8} className={`res-br-${s.breaker}`} />
      ))}
      <text x={PAD - 3} y={h - 15} textAnchor="end" className="res-tiny">{run.config.breaker ? "brk" : ""}</text>
      <g className="res-axis">
        {[0, 15, 30, 45, 60].map((t) => <text key={t} x={x(t)} y={h - 3} textAnchor="middle">{t}s</text>)}
      </g>
      <Sweep id={run.id} h={h - 12} reduced={reduced} />
    </svg>
  );
}

function Result({ run }: { run: Run }) {
  const m = run.summary, c = run.config;
  const errors = m.failed + m.rejected;
  const normal = SECONDS * USERS_PER_S;
  let takeaway: string;
  if (!c.outage) takeaway = "Nothing went wrong, so every setting looks fine. Slow the dependency down and run it again.";
  else if (m.recovery === null && m.retries > 0)
    takeaway = "A retry storm. Each user's request became several calls exactly when the dependency could serve fewest, and it spent its recovered capacity on calls whose callers had already given up. The cause was gone; the overload stayed.";
  else if (m.rejected > 0)
    takeaway = "Without a short timeout, every user waiting on the slow dependency held one of the API's workers. When the pool filled, the API turned away everyone, including requests that never needed the dependency.";
  else if (c.breaker && m.degraded > 0)
    takeaway = "Graceful degradation. Once calls started failing, the breaker opened and users got a fallback at once, the dependency got room to drain its queue, and a few probe calls closed the breaker soon after it recovered.";
  else if (m.recovery !== null && m.recovery > 5)
    takeaway = "No storm, but a slow recovery: the dependency kept working through a backlog of requests whose callers had timed out. A breaker would have stopped the backlog growing.";
  else takeaway = "The slowdown stayed a slowdown. Compare it with Eager retries on the same outage.";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What this minute cost</span>
      <p>
        With {describe(c)}{c.outage ? ` and a ${c.outage}-second slowdown` : ""}: the dependency received {n(m.attempts, "call")} ({(m.attempts / normal).toFixed(1)}× the users), {n(m.wasted, "call")} of them for callers who had already given up.
        Users: {n(m.ok, "answer")}, {n(m.degraded, "fallback")}, {n(errors, "error")}.
        {c.outage ? (m.recovery === null ? " Users were still not served normally when the minute ended." : ` Users were served normally again ${n(m.recovery, "second")} after the dependency recovered.`) : ""}
      </p>
      <p className="pg-takeaway">{takeaway}</p>
    </div>
  );
}

export default function ResiliencyPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const c = st.config;
  const run = shownRun(st);
  const naiveRun = st.runs.find((r) => r.config.outage > 0 && r.config.retries === 3 && r.config.backoff === "none" && !r.config.breaker && r.config.timeout === "1s");
  const answer = naiveRun ? (naiveRun.summary.recovery === null ? "never" : naiveRun.summary.recovery <= 1 ? "1" : "5") : "never";
  const set = (patch: Partial<Config>) => dispatch({ type: "set", patch });

  return (
    <PgFrame title="An API, a slow dependency and one minute" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="The API calls the dependency with a 1 s timeout and retries 3 times at once. The dependency slows down for a while, then is completely healthy again. When are users served normally again?"
        options={[{ value: "1", label: "Within a second" }, { value: "5", label: "A few seconds later" }, { value: "never", label: "Not this minute" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={!!naiveRun}
        answer={answer}
        explain="Not this minute. During the slowdown each user became four calls, the dependency's queue filled with calls nobody was waiting for, and after it recovered it spent its capacity on that backlog. Every answer arrived too late, so the retries never stopped."
      />

      <div className="pg-card">
        <span className="label">The API's client for the recommendations service</span>
        <div className="res-presets pg-actions">
          {PRESETS.map((p) => <PgButton key={p.id} onClick={() => dispatch({ type: "preset", id: p.id })}>{p.label}</PgButton>)}
        </div>
        <div className="res-controls">
          <span className="res-k">Timeout</span>
          <PgChoice<TimeoutOpt> label="Timeout" value={c.timeout} onChange={(v) => set({ timeout: v })}
            options={TIMEOUTS.map((t) => ({ value: t, label: t === "none" ? "None" : t }))} />
          <span className="res-k">Retries</span>
          <PgChoice<string> label="Retries" value={String(c.retries)} onChange={(v) => set({ retries: (v === "budget" ? "budget" : Number(v)) as RetryOpt })}
            options={RETRIES.map((r) => ({ value: String(r), label: r === "budget" ? "3, 10% budget" : String(r), note: r === "budget" ? "Retries may not exceed 10% of first attempts" : undefined }))} />
          <span className="res-k">Backoff</span>
          <PgChoice<BackoffOpt> label="Backoff" value={c.backoff} onChange={(v) => set({ backoff: v })}
            options={[{ value: "none", label: "None" }, { value: "exp", label: "Exponential" }, { value: "jitter", label: "Exp + jitter" }]} />
          <span className="res-k">Breaker</span>
          <PgChoice<string> label="Circuit breaker" value={c.breaker ? "on" : "off"} onChange={(v) => set({ breaker: v === "on" })}
            options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]} />
          <span className="res-k res-break">Break it</span>
          <PgChoice<string> label="Slow the dependency down" value={String(c.outage)} onChange={(v) => set({ outage: Number(v) })}
            options={OUTAGES.map((o) => ({ value: String(o), label: o ? `${o} s slowdown` : "No outage" }))} />
        </div>
        <p className="res-note">Users: {USERS_PER_S}/s. Dependency: {CAP_NORMAL} calls/s normally, 20/s during the slowdown, starting at {OUTAGE_START}s. API workers: {POOL}. Backoff starts at 200 ms and doubles.</p>
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "run" })}>Run one minute</PgButton>
        </div>
      </div>

      {run ? (
        <div className="pg-card">
          <span className="label">Run {run.id} · {describe(run.config)}</span>
          <span className="res-legend"><i className="res-first" />first calls <i className="res-retry" />retries <i className="res-capkey" />capacity</span>
          <LoadChart run={run} reduced={reduced} />
          <span className="res-legend"><i className="res-ok" />answered <i className="res-degraded" />fallback <i className="res-failed" />error <i className="res-rejected" />turned away</span>
          <UserChart run={run} reduced={reduced} />
          <span className="res-legend"><i className="res-poolkey" />API workers busy{run.config.breaker && <> · breaker <i className="res-br-closed" />closed <i className="res-br-open" />open <i className="res-br-half" />half-open</>}</span>
          <PoolChart run={run} reduced={reduced} />
          <dl className="pg-stats">
            <div><dt>Answered</dt><dd>{run.summary.ok.toLocaleString("en")}</dd></div>
            <div><dt>Fallback</dt><dd>{run.summary.degraded.toLocaleString("en")}</dd></div>
            <div className={run.summary.failed + run.summary.rejected ? "bad" : ""}><dt>Errors</dt><dd>{(run.summary.failed + run.summary.rejected).toLocaleString("en")}</dd></div>
            <div className={run.summary.recovery === null ? "bad" : ""}><dt>Recovery</dt><dd>{!run.config.outage ? "n/a" : run.summary.recovery === null ? "not yet" : `${run.summary.recovery} s`}</dd></div>
            <div className={run.summary.peakLoad > CAP_NORMAL ? "bad" : ""}><dt>Peak calls/s</dt><dd>{run.summary.peakLoad}</dd></div>
            <div className={run.summary.wasted ? "bad" : ""}><dt>Wasted calls</dt><dd>{run.summary.wasted.toLocaleString("en")}</dd></div>
            <div className={run.summary.peakInFlight >= POOL - 5 ? "bad" : ""}><dt>Workers peak</dt><dd>{run.summary.peakInFlight}/{POOL}</dd></div>
            <div><dt>Worst latency</dt><dd>{(run.summary.worstLatency / 1000).toFixed(1)} s</dd></div>
          </dl>
        </div>
      ) : (
        <div className="pg-card"><p className="pg-empty">Choose settings, pick a slowdown, and press Run one minute. The defaults are a common first attempt: a 1 s timeout and 3 quick retries.</p></div>
      )}

      {st.runs.length > 1 && (
        <div className="pg-card">
          <span className="label">Your runs · same users, compare the settings</span>
          <div className="res-runs" role="table" aria-label="Your runs">
            <div role="row" className="res-tr head"><span role="columnheader">Settings</span><span role="columnheader">Slowdown</span><span role="columnheader">Errors</span><span role="columnheader">Peak calls/s</span><span role="columnheader">Recovery</span></div>
            {st.runs.map((r) => (
              <button key={r.id} role="row" className={"res-tr" + (r.id === st.shown ? " on" : "")} onClick={() => dispatch({ type: "show", id: r.id })}>
                <span role="cell">{r.id}. {describe(r.config)}</span>
                <span role="cell">{r.config.outage ? `${r.config.outage} s` : "none"}</span>
                <span role="cell">{(r.summary.failed + r.summary.rejected).toLocaleString("en")}</span>
                <span role="cell">{r.summary.peakLoad}</span>
                <span role="cell">{!r.config.outage ? "n/a" : r.summary.recovery === null ? "not yet" : `${r.summary.recovery} s`}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="res-ch">
          {CHALLENGES.map((ch) => (
            <li key={ch.id} className={challengeDone(st, ch.id) ? "done" : ""}>{challengeDone(st, ch.id) ? "✓ " : ""}{ch.text}</li>
          ))}
        </ol>
      </div>

      {run && <Result run={run} />}

      <PgSources links={[
        { title: "Sam Rose's interactive Retries post for Encore", href: "https://encore.dev/blog/retries" },
        { title: "AWS Builders' Library on timeouts, retries and backoff with jitter", href: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/" },
        { title: "Marc Brooker's What is Backoff For?", href: "https://brooker.co.za/blog/2022/08/11/backoff.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.res-presets { gap: 6px; }
.res-controls { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.res-controls .pg-choice { justify-self: start; }
.res-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.res-k.res-break { color: var(--pain); }
.res-note { margin: 0; font-size: .85rem; color: var(--ink-2); }
.res-chart { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.res-band { fill: var(--pain-bg); }
.res-tiny, .res-axis text { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.res-axis line { stroke: var(--line); }
.res-first { fill: var(--accent); }
.res-retry { fill: var(--pain); }
.res-cap { fill: none; stroke: var(--ink); stroke-width: 1.4; stroke-dasharray: 5 3; }
.res-ok { fill: var(--good); }
.res-degraded { fill: var(--accent); opacity: .55; }
.res-failed { fill: var(--pain); }
.res-rejected { fill: var(--ink); }
.res-pool { fill: none; stroke: var(--accent); stroke-width: 2; }
.res-br-closed { fill: var(--good); }
.res-br-open { fill: var(--pain); }
.res-br-half { fill: var(--accent); }
.res-sweep { fill: var(--surface); transform-box: fill-box; transform-origin: right; animation: res-sweep 2.4s linear forwards; }
@keyframes res-sweep { from { transform: scaleX(1); } to { transform: scaleX(0); } }
.res-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-family: var(--f-code); font-size: .62rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.res-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 3px; vertical-align: -1px; }
.res-legend i.res-first { background: var(--accent); }
.res-legend i.res-retry, .res-legend i.res-failed, .res-legend i.res-br-open { background: var(--pain); }
.res-legend i.res-capkey { border-top: 2px dashed var(--ink); height: 0; }
.res-legend i.res-ok, .res-legend i.res-br-closed { background: var(--good); }
.res-legend i.res-degraded { background: var(--accent); opacity: .55; }
.res-legend i.res-rejected { background: var(--ink); }
.res-legend i.res-poolkey { border-top: 2px solid var(--accent); height: 0; }
.res-legend i.res-br-half { background: var(--accent); }
.res-runs { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); font-size: .82rem; }
.res-tr { display: grid; grid-template-columns: minmax(0, 2.4fr) repeat(4, minmax(0, 1fr)); gap: 1px; padding: 0; border: 0; background: var(--line); text-align: left; font: inherit; color: inherit; }
.res-tr > span { background: var(--surface); padding: 4px 6px; font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
.res-tr.head > span { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.res-tr.on > span { background: var(--hl); }
button.res-tr { cursor: pointer; }
.res-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.res-ch li.done { color: var(--good); }
.pg-card .pg-stats + .pg-stats { margin-top: 0; }
@media (max-width: 560px) { .res-controls { grid-template-columns: 1fr; } .res-tr { grid-template-columns: minmax(0, 2fr) repeat(4, minmax(0, 1fr)); font-size: .72rem; } }
@media (prefers-reduced-motion: reduce) { .res-sweep { display: none; } }
`;
