"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, DAYS, HOURS, KINDS, KIND_NAME, KIND_NOTE, KIND_SHORT, POLICY_NAME, POLICY_RULE, SLIS, SLI_NAME, SLI_RULE, SLOS,
  dayOf, evaluate, init, policyOf, startHour, step,
  type Ev, type Result, type Sli, type State, type Tool, type When,
} from "./model";

const W = 600, H = 176, PAD = 30, TOP = 10, BOT = H - 18;
const x = (h: number) => PAD + (h / HOURS) * (W - PAD - 6);
const LOW = -0.5;
const y = (r: number) => TOP + ((1 - Math.max(LOW, Math.min(1, r))) / (1 - LOW)) * (BOT - TOP);
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const num = (v: number) => (v > 0 && v < 10 && !Number.isInteger(v) ? v.toFixed(1) : Math.round(v).toLocaleString("en"));
const at = (h: number) => `day ${dayOf(h)}, ${String(h % 24).padStart(2, "0")}:00`;

function unitOf(sli: Sli) { return sli === "mean" ? "bad hours" : sli === "availability" ? "failed requests" : "slow requests"; }

function BurnChart({ st, r, reduced }: { st: State; r: Result; reduced: boolean }) {
  const pts: string[] = [`${x(0)},${y(1)}`];
  r.remaining.forEach((v, h) => { if (h % 2 === 1 || h === HOURS - 1) pts.push(`${x(h + 1)},${y(v)}`); });
  const end = r.remaining[HOURS - 1];
  const frozen = new Set(r.costs.filter((c) => c.frozen).map((c) => c.id));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="slo-chart" role="img"
      aria-label={`Error budget left over the month: ${pct(Math.max(end, -9), 0)} at the end.${r.exhaustedAt !== null ? ` Ran out on ${at(r.exhaustedAt)}.` : ""}`}>
      <rect x={PAD} y={y(1)} width={W - PAD - 6} height={y(0.5) - y(1)} className="slo-band-g" />
      <rect x={PAD} y={y(0.5)} width={W - PAD - 6} height={y(0) - y(0.5)} className="slo-band-a" />
      <rect x={PAD} y={y(0)} width={W - PAD - 6} height={y(LOW) - y(0)} className="slo-band-r" />
      {[0, 5, 10, 15, 20, 25, 30].map((d) => <line key={d} x1={x(d * 24)} x2={x(d * 24)} y1={TOP} y2={BOT} className="slo-grid" />)}
      <line x1={x(0)} y1={y(1)} x2={x(HOURS)} y2={y(0)} className="slo-ideal" />
      <text x={x(HOURS * 0.62)} y={y(0.38) - 4} className="slo-tiny">burn rate 1: spent exactly by day 30</text>
      <polyline key={reduced ? "s" : JSON.stringify(st.events.map((e) => e.id)) + st.sli + st.slo} points={pts.join(" ")} className={"slo-line" + (reduced ? "" : " draw")} />
      {st.events.map((e) => (
        <g key={e.id} className={"slo-mark k-" + e.kind + (frozen.has(e.id) ? " frozen" : "")}>
          <line x1={x(startHour(e))} x2={x(startHour(e))} y1={BOT - 7} y2={BOT} />
        </g>
      ))}
      {r.exhaustedAt !== null && (
        <g className="slo-out">
          <circle cx={x(r.exhaustedAt + 1)} cy={y(0)} r={4} />
          <text x={Math.min(x(r.exhaustedAt + 1) + 6, W - 120)} y={y(0) + 13}>budget gone · {at(r.exhaustedAt)}</text>
        </g>
      )}
      <g className="slo-axis">
        <text x={PAD - 4} y={y(1) + 4} textAnchor="end">100%</text>
        <text x={PAD - 4} y={y(0.5) + 4} textAnchor="end">50%</text>
        <text x={PAD - 4} y={y(0) + 4} textAnchor="end">0</text>
        <text x={PAD - 4} y={y(LOW)} textAnchor="end">-50%</text>
        {[0, 10, 20, 30].map((d) => <text key={d} x={x(d * 24)} y={H - 4} textAnchor="middle">day {d}</text>)}
      </g>
    </svg>
  );
}

function DayStrip({ st, r, onDay }: { st: State; r: Result; onDay: (d: number) => void }) {
  const frozen = new Set(r.costs.filter((c) => c.frozen).map((c) => c.id));
  return (
    <div className="slo-days" role="group" aria-label={`The 30 days. Click a day to ${st.tool === "remove" ? "remove its last event" : `add a ${KIND_NAME[st.tool as Exclude<Tool, "remove">].toLowerCase()}`}.`}>
      {Array.from({ length: DAYS }, (_, i) => i + 1).map((d) => {
        const evs = st.events.filter((e) => e.day === d);
        const hEnd = d * 24 - 1;
        const pol = policyOf(r.remaining[hEnd]);
        const label = evs.length ? evs.map((e) => `${KIND_NAME[e.kind]} at ${e.when === "peak" ? "peak" : "night"}${frozen.has(e.id) ? " (frozen)" : ""}`).join(", ") : "nothing planned";
        return (
          <button key={d} className={"slo-day p-" + pol} onClick={() => onDay(d)} aria-label={`Day ${d}: ${label}. Budget at end of day ${pct(Math.max(r.remaining[hEnd], -9), 0)}.`} title={`Day ${d}: ${label}`}>
            <span className="slo-dn">{d}</span>
            <span className="slo-evs">
              {evs.map((e) => <i key={e.id} className={"k-" + e.kind + (frozen.has(e.id) ? " frozen" : "") + (e.when === "quiet" ? " night" : "")}>{KIND_SHORT[e.kind]}</i>)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function costLine(e: Ev, share: number, frozen: boolean, sli: Sli) {
  const when = e.when === "peak" ? "afternoon" : "night";
  if (frozen) return `${KIND_NAME[e.kind]}, day ${e.day}: frozen by the policy, cost nothing`;
  return `${KIND_NAME[e.kind]}, day ${e.day} (${when}): ${share > 0 ? pct(share) : sli === "mean" ? "0% (the hourly mean stayed under 250 ms)" : "0% (this SLI does not see it)"} of the budget`;
}

function ResultText({ st, r }: { st: State; r: Result }) {
  const end = r.remaining[HOURS - 1];
  const top = [...r.costs].filter((c) => !c.frozen).sort((a, b) => b.share - a.share)[0];
  const topEv = top ? st.events.find((e) => e.id === top.id)! : null;
  const slow = st.events.some((e) => e.kind === "slow");
  let take: string;
  if (st.sli === "mean" && slow && r.bad === 0)
    take = "The SLI says the month was perfect while a fifth of checkouts took 700 ms for hours. An average hides the slow tail, and an SLI that cannot see a user's pain cannot spend budget on it. Measure the share of requests under a threshold instead.";
  else if (st.sli === "latency" && r.remaining.findIndex((v) => v <= 0) >= 0 && st.events.every((e) => e.kind !== "slow"))
    take = `Nothing went wrong this month, yet the budget ran out: ${pct(0.003)} of requests are always slower than 300 ms, more than a ${st.slo}% target allows. Start a target from what the service does today and what users need, not from a round number.`;
  else if (r.frozen > 0)
    take = `The budget ran out on ${at(r.exhaustedAt!)}, so the policy froze ${r.frozen} release${r.frozen === 1 ? "" : "s"}. Nobody argued about it in the incident: everyone signed the policy before the month began. A release that was frozen cannot fail.`;
  else if (topEv && top.share >= 0.3)
    take = `One ${KIND_NAME[topEv.kind].toLowerCase()} spent ${pct(top.share, 0)} of the month's budget. At ${st.slo}% the whole month allows ${r.sli === "mean" ? `${num(r.budget)} bad hour${r.budget === 1 ? "" : "s"}` : `about ${Math.round(r.budgetMinutes)} minutes of total failure at average traffic`}. ${topEv.when === "peak" ? "It hit at the afternoon peak; the same incident at night costs about a quarter as much, because the budget counts requests, not minutes." : "It hit at night, when traffic is low; at the afternoon peak it would cost about four times as much."}`;
  else take = `Releases and background errors spent ${pct(1 - end, 0)} of the budget. Place a bad release or a zone outage on a day and watch the line drop.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What this month cost</span>
      <p>
        SLI: {SLI_NAME[st.sli].toLowerCase()}, target {st.slo}% over 30 days. The month allowed {num(r.budget)} {unitOf(st.sli)} and had {num(r.bad)}, so the SLI came out at {(r.value * 100).toFixed(3)}% and {end > 0 ? `${pct(end, 0)} of the budget was left` : `the budget was overspent by ${pct(-end, 0)}`}.
        {r.exhaustedAt !== null ? ` It ran out on ${at(r.exhaustedAt)}.` : ""} {r.shipped} release{r.shipped === 1 ? "" : "s"} shipped, {r.frozen} frozen.
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function SlisAndSlosPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const r = evaluate(st.events, st.sli, st.slo);
  const end = r.remaining[HOURS - 1];
  const pol = policyOf(end);
  const badPeak = st.events.some((e) => e.kind === "bad" && e.when === "peak");
  const costs = r.costs.filter((c) => c.share > 0.001 || c.frozen || st.events.find((e) => e.id === c.id)!.kind !== "release")
    .sort((a, b) => b.share - a.share).slice(0, 5);

  return (
    <PgFrame title="A month of checkout traffic and its error budget" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="The SLO: 99.9% of checkout requests succeed over 30 days. A bad release fails every request for 20 minutes at the afternoon peak. How much of the month's error budget does it use?"
        options={[{ value: "1", label: "About 1%" }, { value: "10", label: "About 10%" }, { value: "75", label: "About three quarters" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={badPeak}
        answer="75"
        explain={<>About three quarters. 99.9% over a month of 72 million requests allows 72,000 failures, about 43 minutes of total failure at average traffic. The afternoon peak serves about 160,000 requests an hour, so 20 minutes of failure there is about 53,000 failed requests: 74% of the budget.</>}
      />

      <div className="pg-card">
        <span className="label">The objective</span>
        <div className="slo-controls">
          <span className="slo-k">SLI</span>
          <PgChoice<Sli> label="Service level indicator" value={st.sli} onChange={(v) => dispatch({ type: "sli", sli: v })}
            options={SLIS.map((s) => ({ value: s, label: SLI_NAME[s], note: SLI_RULE[s] }))} />
          <span className="slo-k">SLO</span>
          <PgChoice<string> label="Target" value={String(st.slo)} onChange={(v) => dispatch({ type: "slo", slo: Number(v) as State["slo"] })}
            options={SLOS.map((s) => ({ value: String(s), label: `${s}%` }))} />
        </div>
        <p className="slo-note">{SLI_RULE[st.sli]}. Budget: {num(r.budget)} {unitOf(st.sli)} in 30 days{st.sli === "mean" ? "" : `, the same as ${r.budgetMinutes < 10 ? r.budgetMinutes.toFixed(1) : Math.round(r.budgetMinutes)} minutes of total failure at average traffic`}.</p>
      </div>

      <div className="pg-card">
        <span className="label">The month · click a day to place an event</span>
        <div className="slo-controls">
          <span className="slo-k">Place</span>
          <PgChoice<Tool> label="Event to place" value={st.tool} onChange={(v) => dispatch({ type: "tool", tool: v })}
            options={[...KINDS.map((k) => ({ value: k as Tool, label: KIND_NAME[k], note: KIND_NOTE[k] })), { value: "remove" as Tool, label: "Remove" }]} />
          <span className="slo-k">When</span>
          <PgChoice<When> label="Time of day" value={st.when} onChange={(v) => dispatch({ type: "when", when: v })}
            options={[{ value: "peak", label: "Afternoon peak" }, { value: "quiet", label: "Night" }]} />
        </div>
        <p className="slo-note">{st.tool === "remove" ? "Click a day to remove its last event." : `${KIND_NAME[st.tool]}: ${KIND_NOTE[st.tool]}.`} Traffic peaks at about 160,000 requests an hour at 14:00 and falls to about 40,000 at night.</p>
        <span className="slo-legend"><i className="lg-g" />more than half left <i className="lg-a" />at risk <i className="lg-r" />exhausted <i className="lg-i" />even burn</span>
        <BurnChart st={st} r={r} reduced={reduced} />
        <DayStrip st={st} r={r} onDay={(d) => dispatch({ type: "day", day: d })} />
        <div className="pg-actions"><PgButton onClick={() => dispatch({ type: "clear" })}>Clear the month</PgButton></div>
      </div>

      <div className="pg-card">
        <span className="label">Error budget policy · end of the month</span>
        <p className={"slo-policy p-" + pol}><b>{POLICY_NAME[pol]}.</b> {POLICY_RULE[pol]}</p>
        <dl className="pg-stats">
          <div><dt>SLI this month</dt><dd>{(r.value * 100).toFixed(3)}%</dd></div>
          <div className={end <= 0 ? "bad" : ""}><dt>Budget left</dt><dd>{pct(end, 0)}</dd></div>
          <div className={r.amberAt !== null ? "bad" : ""}><dt>Below half</dt><dd>{r.amberAt === null ? "never" : `day ${dayOf(r.amberAt)}`}</dd></div>
          <div className={r.exhaustedAt !== null ? "bad" : ""}><dt>Ran out</dt><dd>{r.exhaustedAt === null ? "never" : `day ${dayOf(r.exhaustedAt)}`}</dd></div>
          <div><dt>Allowed</dt><dd>{num(r.budget)}</dd></div>
          <div><dt>Spent</dt><dd>{num(r.bad)}</dd></div>
          <div><dt>Shipped</dt><dd>{r.shipped}</dd></div>
          <div className={r.frozen ? "bad" : ""}><dt>Frozen</dt><dd>{r.frozen}</dd></div>
        </dl>
        {costs.length > 0 && (
          <ul className="slo-costs">
            {costs.map((c) => { const e = st.events.find((v) => v.id === c.id)!; return <li key={c.id} className={c.frozen ? "frozen" : ""}>{costLine(e, c.share, c.frozen, st.sli)}</li>; })}
          </ul>
        )}
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="slo-ch">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "done" : ""}>{st.done[c.id] ? "✓ " : ""}{c.text}</li>)}
        </ol>
      </div>

      <ResultText st={st} r={r} />

      <PgSources links={[
        { title: "the Site Reliability Workbook chapter on implementing SLOs", href: "https://sre.google/workbook/implementing-slos/" },
        { title: "Alex Ewerlof's Service Level Calculator", href: "https://blog.alexewerlof.com/p/slc" },
        { title: "Grafana's SLO error budget burn-down panels", href: "https://grafana.com/docs/grafana-cloud/alerting-and-irm/slo/dashboard/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.slo-controls { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.slo-controls .pg-choice { justify-self: start; }
.slo-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.slo-note { margin: 0; font-size: .85rem; color: var(--ink-2); }
.slo-chart { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.slo-band-g { fill: var(--good-bg); }
.slo-band-a { fill: var(--hl); }
.slo-band-r { fill: var(--pain-bg); }
.slo-grid { stroke: var(--line); }
.slo-ideal { stroke: var(--ink-2); stroke-dasharray: 4 3; }
.slo-tiny, .slo-axis text, .slo-out text { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.slo-out circle { fill: var(--pain); }
.slo-out text { fill: var(--pain); }
.slo-line { fill: none; stroke: var(--accent); stroke-width: 2.2; }
.slo-line.draw { stroke-dasharray: 2400; stroke-dashoffset: 2400; animation: slo-draw .9s var(--ease) forwards; }
@keyframes slo-draw { to { stroke-dashoffset: 0; } }
.slo-mark line { stroke: var(--ink); stroke-width: 2; }
.slo-mark.k-bad line, .slo-mark.k-zone line { stroke: var(--pain); }
.slo-mark.k-slow line { stroke: var(--accent); }
.slo-mark.frozen line { stroke: var(--ink-2); stroke-dasharray: 2 2; }
.slo-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-family: var(--f-code); font-size: .62rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.slo-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 3px; vertical-align: -1px; border: 1px solid var(--line); }
.slo-legend i.lg-g { background: var(--good-bg); } .slo-legend i.lg-a { background: var(--hl); } .slo-legend i.lg-r { background: var(--pain-bg); }
.slo-legend i.lg-i { border: 0; border-top: 2px dashed var(--ink-2); height: 0; }
.slo-days { display: grid; grid-template-columns: repeat(30, minmax(0, 1fr)); gap: 2px; margin-left: calc(${PAD / W * 100}% ); margin-right: 1%; }
.slo-day { border: 1px solid var(--line); background: var(--surface); padding: 2px 0 3px; min-height: 46px; display: grid; align-content: start; justify-items: center; gap: 2px; font: inherit; color: inherit; cursor: pointer; border-top-width: 3px; }
.slo-day.p-green { border-top-color: var(--good); } .slo-day.p-amber { border-top-color: var(--accent); } .slo-day.p-red { border-top-color: var(--pain); }
.slo-day:hover, .slo-day:focus-visible { background: var(--hl); }
.slo-dn { font-family: var(--f-code); font-size: .55rem; color: var(--ink-2); }
.slo-evs { display: grid; gap: 1px; }
.slo-evs i { font-style: normal; font-family: var(--f-code); font-size: .6rem; font-weight: 700; width: 14px; height: 14px; line-height: 14px; text-align: center; background: var(--ink); color: var(--surface); }
.slo-evs i.k-bad, .slo-evs i.k-zone { background: var(--pain); }
.slo-evs i.k-slow { background: var(--accent); color: var(--accent-ink); }
.slo-evs i.night { outline: 1px dashed var(--ink-2); outline-offset: 1px; }
.slo-evs i.frozen { background: transparent; color: var(--ink-2); text-decoration: line-through; border: 1px dashed var(--ink-2); }
.slo-policy { margin: 0; padding: 6px 10px; border-left: 4px solid var(--good); background: var(--good-bg); }
.slo-policy.p-amber { border-left-color: var(--accent); background: var(--hl); }
.slo-policy.p-red { border-left-color: var(--pain); background: var(--pain-bg); }
.slo-costs { margin: 0; padding-left: 1.2em; font-size: .9rem; display: grid; gap: 2px; }
.slo-costs li.frozen { color: var(--ink-2); }
.slo-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.slo-ch li.done { color: var(--good); }
@media (max-width: 560px) {
  .slo-controls { grid-template-columns: 1fr; }
  .slo-days { grid-template-columns: repeat(10, minmax(0, 1fr)); margin-left: 0; margin-right: 0; }
}
@media (prefers-reduced-motion: reduce) { .slo-line.draw { animation: none; stroke-dashoffset: 0; } }
`;
