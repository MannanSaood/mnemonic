"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ALGO_NAME, ALGO_RULE, BURSTS, CHALLENGES, PATTERN_NAME, PER_CLICK, RATES, SLOT, SLOTS, SPAN, USES_BURST, WINDOW,
  histogram, init, runAll, step,
  type Burst, type Lane, type Pattern, type Rate, type State,
} from "./model";

const W = 600, PAD = 6;
const x = (t: number) => PAD + (t / SPAN) * (W - 2 * PAD);
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

function Strip({ st, onSlot }: { st: State; onSlot: (i: number) => void }) {
  const h = histogram(st.arrivals);
  const max = Math.max(10, ...h);
  return (
    <div className="rl-strip" role="group" aria-label={`Traffic: ${st.arrivals.length} requests over 4 seconds. Each button adds ${PER_CLICK} requests in that 100 ms slot.`}>
      {h.map((n, i) => (
        <button key={i} className={"rl-slot" + (i % 10 === 0 ? " sec" : "")} onClick={() => onSlot(i)}
          title={`${(i * SLOT / 1000).toFixed(1)}–${((i + 1) * SLOT / 1000).toFixed(1)} s: ${n} requests. Click to add ${PER_CLICK}.`}
          aria-label={`${(i * SLOT / 1000).toFixed(1)} seconds, ${n} requests, add ${PER_CLICK}`}>
          <i style={{ height: `${(n / max) * 100}%` }} />
        </button>
      ))}
      <div className="rl-axis" aria-hidden="true">{[0, 1, 2, 3, 4].map((s) => <span key={s}>{s}s</span>)}</div>
    </div>
  );
}

function LaneView({ lane, rate, reduced }: { lane: Lane; rate: number; reduced: boolean }) {
  const over = lane.peak > rate;
  const h = 56, mid = 28;
  return (
    <div className={"rl-lane" + (over ? " over" : "")}>
      <header>
        <h4>{ALGO_NAME[lane.algo]}</h4>
        <span className="rl-rule">{ALGO_RULE[lane.algo]}</span>
        <span className="rl-nums">
          <b className="ok">{lane.admitted} in</b> · <b className="no">{lane.rejected} 429</b> · <b className={over ? "no" : ""}>busiest 1 s: {lane.peak}/{rate}</b>
          {lane.algo === "leaky" && <> · max wait {lane.maxDelay} ms</>}
        </span>
      </header>
      <svg viewBox={`0 0 ${W} ${h}`} className="rl-svg" role="img"
        aria-label={`${ALGO_NAME[lane.algo]}: ${lane.admitted} admitted, ${lane.rejected} rejected, at most ${lane.peak} reached the backend in one second against a limit of ${rate}.`}>
        {[1, 2, 3].map((s) => <line key={s} x1={x(s * WINDOW)} x2={x(s * WINDOW)} y1={2} y2={h - 2} className={lane.algo === "fixed" ? "rl-win hard" : "rl-win"} />)}
        {lane.peak > 0 && <rect x={x(lane.peakAt)} y={3} width={x(lane.peakAt + WINDOW) - x(lane.peakAt)} height={h - 6} className={over ? "rl-peak over" : "rl-peak"} />}
        <line x1={PAD} x2={W - PAD} y1={mid} y2={mid} className="rl-base" />
        {lane.decisions.map((d, i) => d.ok ? (
          <g key={i}>
            {d.out !== null && d.out - d.t > 1 && <line x1={x(d.t)} x2={x(d.out)} y1={mid - 2} y2={mid - 14} className="rl-wait" />}
            <line x1={x(d.out ?? d.t)} x2={x(d.out ?? d.t)} y1={mid - 1} y2={mid - 20} className={"rl-in" + (d.node ? " n1" : "") + (reduced ? "" : " anim")} />
          </g>
        ) : (
          <line key={i} x1={x(d.t)} x2={x(d.t)} y1={mid + 1} y2={mid + 20} className={"rl-out" + (reduced ? "" : " anim")} />
        ))}
      </svg>
    </div>
  );
}

function Result({ st, lanes }: { st: State; lanes: Lane[] }) {
  const r = st.config.rate;
  const by = Object.fromEntries(lanes.map((l) => [l.algo, l])) as Record<string, Lane>;
  const total = st.arrivals.length;
  const worst = [...lanes].sort((a, b) => b.peak - a.peak)[0];
  const strict = lanes.filter((l) => l.peak <= r).map((l) => ALGO_NAME[l.algo]);
  let take: string;
  if (st.config.race && worst.peak > r)
    take = `Two gateways read the same stored count, each decided on its own, and the second write erased the first. ${ALGO_NAME[worst.algo]} let ${worst.peak} through in one second against a limit of ${r}. The algorithm was fine; the update was not atomic. In a shared store, the read, the decision and the write must be one operation.`;
  else if (by.fixed.peak >= 1.5 * r)
    take = `The fixed window let ${by.fixed.peak} through in the second starting at ${sec(by.fixed.peakAt)}, ${(by.fixed.peak / r).toFixed(1)}× the limit. Each burst fell in a different clock second, and each second's count started at zero. The sliding log, which looks back a full second from every request, let ${by.log.peak} through.`;
  else if (by.leaky.maxDelay > 0)
    take = `The leaky bucket admitted ${by.leaky.admitted} but made some wait up to ${by.leaky.maxDelay} ms, so the backend never saw more than ${by.leaky.peak} in a second. The token bucket admitted ${by.token.admitted} at once, up to ${by.token.peak} in one second: its burst of ${st.config.burst} is a promise to let bursts through.`;
  else if (lanes.every((l) => l.rejected === 0))
    take = "Under the limit, every algorithm agrees. The differences only show in bursts: press Boundary burst, or click the strip to pile requests into one slot.";
  else take = `Same traffic, five answers. Only ${strict.join(", ")} kept every second at or under ${r}.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What this traffic did</span>
      <p>
        {total} requests at a limit of {r}/s{st.config.race ? " on two gateways sharing one store" : ""}. Admitted: {lanes.map((l) => `${ALGO_NAME[l.algo].toLowerCase()} ${l.admitted}`).join(", ")}.
        Busiest second at the backend: {lanes.map((l) => `${l.peak}`).join(" / ")}.
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function RateLimiterPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const c = st.config;
  const lanes = runAll(st.arrivals, c);
  const fixed = lanes.find((l) => l.algo === "fixed")!;

  return (
    <PgFrame title="Five limiters, one stream of requests" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="The limit is 10 requests per second. A client sends 10 requests in the last 100 ms of one second and 10 more in the first 100 ms of the next. How many does a fixed-window limiter let through?"
        options={[{ value: "10", label: "10" }, { value: "15", label: "15" }, { value: "20", label: "All 20" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.sawBoundary}
        answer="20"
        explain={<>All 20, in 200 ms. The first 10 count against one clock second, the next 10 against a fresh one. Each window is within its limit, so nothing is refused. The sliding log asks &quot;how many in the last second?&quot; at every request and lets 10 through.</>}
      />

      <div className="pg-card">
        <span className="label">Traffic · click a slot to add {PER_CLICK} requests there</span>
        <Strip st={st} onSlot={(slot) => dispatch({ type: "slot", slot })} />
        <div className="pg-actions">
          {(Object.keys(PATTERN_NAME) as Pattern[]).map((p) => (
            <button key={p} className={"pg-btn rl-pat" + (p === "boundary" ? " rl-break" : "")} aria-pressed={st.pattern === p}
              onClick={() => dispatch({ type: "pattern", pattern: p })}>{PATTERN_NAME[p]}</button>
          ))}
          <PgButton onClick={() => dispatch({ type: "clear" })}>Clear</PgButton>
        </div>
        <div className="rl-controls">
          <span className="rl-k">Limit r</span>
          <PgChoice<string> label="Limit per second" value={String(c.rate)} onChange={(v) => dispatch({ type: "rate", rate: Number(v) as Rate })}
            options={RATES.map((r) => ({ value: String(r), label: `${r}/s` }))} />
          <span className="rl-k">Burst b</span>
          <PgChoice<string> label="Burst size" value={String(c.burst)} onChange={(v) => dispatch({ type: "burst", burst: Number(v) as Burst })}
            options={BURSTS.map((b) => ({ value: String(b), label: String(b), note: "Bucket size for the token and leaky buckets" }))} />
          <span className="rl-k rl-breakk">Break it</span>
          <button className="pg-btn rl-break" aria-pressed={c.race} onClick={() => dispatch({ type: "race", on: !c.race })}
            title="Two gateways share the store and do read, decide, write as separate steps">
            {c.race ? "✓ " : ""}Two gateways, no atomic update
          </button>
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Same requests, five limiters · up: admitted · down: 429 · box: busiest second at the backend</span>
        <div className="rl-lanes">
          {lanes.map((l) => <LaneView key={l.algo} lane={l} rate={c.rate} reduced={reduced} />)}
        </div>
        <p className="rl-note">Burst b applies to {Object.entries(USES_BURST).filter(([, v]) => v).map(([k]) => ALGO_NAME[k as keyof typeof ALGO_NAME].toLowerCase()).join(" and ")}. Dashed lines are clock seconds; the fixed window resets on them.</p>
        <dl className="pg-stats">
          <div><dt>Requests</dt><dd>{st.arrivals.length}</dd></div>
          <div><dt>Limit</dt><dd>{c.rate}/s</dd></div>
          <div className={fixed.peak > c.rate ? "bad" : ""}><dt>Fixed window peak</dt><dd>{fixed.peak} in 1 s</dd></div>
          <div className={lanes.some((l) => l.peak > c.rate) ? "bad" : ""}><dt>Worst peak</dt><dd>{Math.max(...lanes.map((l) => l.peak))} in 1 s</dd></div>
        </dl>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="rl-ch">
          {CHALLENGES.map((x) => <li key={x.id} className={st.done[x.id] ? "done" : ""}>{st.done[x.id] ? "✓ " : ""}{x.text}</li>)}
        </ol>
      </div>

      {st.arrivals.length > 0 && <Result st={st} lanes={lanes} />}

      <PgSources links={[
        { title: "the Redis tutorial Build 5 Rate Limiters with Redis", href: "https://redis.io/tutorials/howtos/ratelimiting/" },
        { title: "Dan McCreary's Token Bucket vs. Leaky Bucket MicroSim", href: "https://dmccreary.github.io/networking/sims/token-vs-leaky-bucket/" },
        { title: "Sagyam Thapa's Interactive Guide to Rate Limiting", href: "https://dev.to/sagyam/interactive-guide-to-rate-limiting-58p3" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.rl-strip { position: relative; display: grid; grid-template-columns: repeat(${SLOTS}, minmax(0, 1fr)); gap: 1px; height: 76px; padding-bottom: 14px; background: var(--surface); border: 1px solid var(--line); }
.rl-slot { position: relative; border: 0; padding: 0; background: transparent; display: flex; align-items: flex-end; cursor: copy; }
.rl-slot.sec { border-left: 1px dashed var(--line); }
.rl-slot:hover, .rl-slot:focus-visible { background: var(--hl); }
.rl-slot i { display: block; width: 100%; background: var(--accent); transition: height .25s var(--ease); }
.rl-axis { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-between; font-family: var(--f-code); font-size: 9px; color: var(--ink-2); padding: 0 2px; pointer-events: none; }
.rl-controls { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.rl-controls > .pg-choice, .rl-controls > .pg-btn { justify-self: start; }
.rl-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.rl-breakk { color: var(--pain); }
.pg-btn.rl-break { border-color: var(--pain); color: var(--pain); }
.pg-btn.rl-pat[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.pg-btn.rl-break[aria-pressed="true"] { background: var(--pain); color: var(--bg); border-color: var(--pain); }
.rl-lanes { display: grid; gap: 8px; }
.rl-lane { border: 1px solid var(--line); background: var(--bg); padding: 6px 8px; display: grid; gap: 4px; }
.rl-lane.over { border-color: var(--pain); }
.rl-lane header { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: baseline; }
.rl-lane h4 { margin: 0; font-family: var(--f-display); font-variation-settings: "wdth" 75; font-size: 1.05rem; text-transform: uppercase; }
.rl-rule { font-size: .8rem; color: var(--ink-2); }
.rl-nums { margin-left: auto; font-family: var(--f-code); font-size: .7rem; font-variant-numeric: tabular-nums; }
.rl-nums b { font-weight: 600; }
.rl-nums .ok { color: var(--good); } .rl-nums .no { color: var(--pain); }
.rl-svg { width: 100%; height: auto; display: block; background: var(--surface); }
.rl-win { stroke: var(--line); stroke-dasharray: 3 3; }
.rl-win.hard { stroke: var(--ink-2); stroke-dasharray: none; stroke-width: 1.4; }
.rl-base { stroke: var(--line); }
.rl-peak { fill: var(--hl); opacity: .7; }
.rl-peak.over { fill: var(--pain-bg); opacity: 1; stroke: var(--pain); stroke-width: 1; }
.rl-in { stroke: var(--good); stroke-width: 1.6; }
.rl-in.n1 { stroke: var(--accent); }
.rl-out { stroke: var(--pain); stroke-width: 1.6; }
.rl-wait { stroke: var(--good); stroke-width: .8; opacity: .5; }
.rl-in.anim, .rl-out.anim { animation: rl-pop .3s var(--ease) both; }
@keyframes rl-pop { from { opacity: 0; } to { opacity: 1; } }
.rl-note { margin: 0; font-size: .82rem; color: var(--ink-2); }
.rl-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.rl-ch li.done { color: var(--good); }
@media (max-width: 560px) { .rl-controls { grid-template-columns: 1fr; } .rl-nums { margin-left: 0; } .rl-rule { display: none; } }
@media (prefers-reduced-motion: reduce) { .rl-slot i { transition: none; } .rl-in.anim, .rl-out.anim { animation: none; } }
`;
