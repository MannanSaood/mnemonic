"use client";
import { useMemo } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, DAYS, KINDS, KIND_NAME, KIND_SPEC, MINUTES, SINGLE_BURNS, SINGLE_WINDOWS,
  budgetShare, describeCond, evaluate, hourly, init, significant, span, step, windowName,
  type Incident, type State, type StratResult, type Tool, type Traffic, type Window,
} from "./model";

const W = 600, PAD = 34;
const xm = (m: number) => PAD + (m / MINUTES) * (W - PAD - 6);
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const dur = (m: number) => (m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${(m / 60).toFixed(m < 600 ? 1 : 0)} h` : `${(m / 1440).toFixed(1)} d`);

function RateChart({ st, hours }: { st: State; hours: { ratio: number }[] }) {
  const H = 150, TOP = 8, BOT = H - 18;
  const lo = -5, hi = 0;
  const y = (r: number) => TOP + ((hi - Math.log10(Math.max(r, 1e-5))) / (hi - lo)) * (BOT - TOP);
  const pts = hours.map((h, i) => `${xm(i * 60)},${y(h.ratio)} ${xm(i * 60 + 60)},${y(h.ratio)}`).join(" ");
  const lines = [{ r: 0.001, t: "SLO line 0.1% (burn 1×)" }, { r: 0.006, t: "6×" }, { r: 0.0144, t: "14.4×" }];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="br-chart" role="img" aria-label="Error rate per hour over the month, on a log scale, with the SLO line and the 6× and 14.4× burn-rate lines.">
      {st.incidents.filter(significant).map((i) => { const [a, b] = span(i); return <rect key={i.id} x={xm(a)} y={TOP} width={Math.max(3, xm(b) - xm(a))} height={BOT - TOP} className="br-inc" />; })}
      <polyline points={`${xm(0)},${BOT} ${pts} ${xm(MINUTES)},${BOT}`} className="br-area" />
      {lines.map((l) => (
        <g key={l.r}>
          <line x1={PAD} x2={W - 6} y1={y(l.r)} y2={y(l.r)} className={l.r === 0.001 ? "br-slo" : "br-burn"} />
          <text x={W - 8} y={y(l.r) - 2} textAnchor="end" className="br-tiny">{l.t}</text>
        </g>
      ))}
      <g className="br-axis">
        {[1, 0.01, 0.0001].map((r) => <text key={r} x={PAD - 3} y={y(r) + 3} textAnchor="end">{r >= 0.01 ? pct(r, 0) : "0.01%"}</text>)}
        {[0, 10, 20, 30].map((d) => <text key={d} x={xm(d * 1440)} y={H - 4} textAnchor="middle">day {d}</text>)}
      </g>
    </svg>
  );
}

function Lane({ r, st, reduced }: { r: StratResult; st: State; reduced: boolean }) {
  const H = 30;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="br-lane" role="img"
      aria-label={`${r.rule.name}: ${r.pages} pages (${r.falsePages} false), ${r.tickets} tickets, ${r.missed} significant incidents missed.`}>
      {st.incidents.filter(significant).map((i) => { const [a, b] = span(i); return <rect key={i.id} x={xm(a)} y={0} width={Math.max(3, xm(b) - xm(a))} height={H} className="br-inc" />; })}
      <line x1={PAD} x2={W - 6} y1={H / 2} y2={H / 2} className="br-base" />
      {r.episodes.map((e, k) => (
        <rect key={k} x={xm(e.start)} y={e.severity === "page" ? 4 : 10} width={Math.max(2.5, xm(e.end) - xm(e.start))} height={e.severity === "page" ? H - 8 : H - 20}
          className={`br-ep ${e.severity}${e.falseAlarm ? " false" : ""}${reduced ? "" : " pop"}`} style={reduced ? undefined : { animationDelay: `${(e.start / MINUTES) * 900}ms` }} />
      ))}
    </svg>
  );
}

function DayStrip({ st, onDay }: { st: State; onDay: (d: number) => void }) {
  return (
    <div className="br-days" role="group" aria-label="The 30 days. Click a day to place the chosen incident.">
      {Array.from({ length: DAYS }, (_, i) => i + 1).map((d) => {
        const on = st.incidents.filter((i) => i.day === d);
        return (
          <button key={d} className="br-day" onClick={() => onDay(d)} title={`Day ${d}: ${on.map((i) => KIND_NAME[i.kind]).join(", ") || "quiet"}`}
            aria-label={`Day ${d}: ${on.map((i) => KIND_NAME[i.kind]).join(", ") || "no incident"}`}>
            <span className="br-dn">{d}</span>
            {on.map((i) => <i key={i.id} className={"k-" + i.kind}>{i.kind === "outage" ? "O" : i.kind === "partial" ? "P" : i.kind === "leak" ? "L" : "b"}</i>)}
          </button>
        );
      })}
    </div>
  );
}

function cell(r: StratResult, i: Incident) {
  const d = r.detections.find((x) => x.id === i.id);
  if (!d) return { text: "n/a", cls: "" };
  if (d.at === null) return { text: "missed", cls: "bad" };
  return { text: `${d.severity === "ticket" ? "ticket" : "page"} after ${dur(d.at)}`, cls: d.severity === "ticket" ? "tk" : "" };
}

function Result({ st, res }: { st: State; res: StratResult[] }) {
  const [th, single, multi] = res;
  const sig = st.incidents.filter(significant);
  const blips = st.incidents.filter((i) => i.kind === "blips").length;
  let take: string;
  if (st.traffic === "quiet")
    take = `At 10 requests an hour, one failed request is a 10% error rate for the hour, a burn rate of 100. Every rule pages for it: ${multi.falsePages} false page${multi.falsePages === 1 ? "" : "s"} from the multiwindow rule, while real incidents produce too few requests to see. Low-traffic services need synthetic probes, grouping with related services, or a longer window.`;
  else if (sig.length === 0)
    take = "No incident here threatens the SLO, so the best alert is silent. Place a total outage, a partial outage or a slow leak.";
  else if (single.missed > 0 && multi.missed === 0)
    take = `The one-window rule missed ${single.missed} significant incident${single.missed === 1 ? "" : "s"}: a burn just under its threshold never fires, however long it lasts. The multiwindow rule caught everything with ${multi.falsePages} false pages, paging for fast burns and opening a ticket for the slow one.${blips ? ` The threshold rule paged ${th.pages} times, ${th.falsePages} of them for blips that spent less than 1% of the budget each.` : ""}`;
  else if (single.missed === 0 && single.worstReset !== null && single.worstReset > 120)
    take = `The one-window rule now catches everything, and pays for it: ${st.incidents.some((i) => i.kind === "leak") ? "it pages, at any hour, for a slow leak that could have waited for a ticket, and it " : "it "}keeps firing for up to ${dur(single.worstReset)} after an incident ends, because a ${windowName(st.single.window)} average remembers it. The short window is what lets the multiwindow page stop ${dur(multi.detections.filter((d) => d.severity === "page").reduce((a, d) => Math.max(a, d.reset ?? 0), 0))} after recovery.`;
  else take = `Threshold: ${th.pages} pages, ${th.falsePages} false. One window: ${single.pages} pages, ${single.missed} missed. Multiwindow: ${multi.pages} pages, ${multi.tickets} tickets, ${multi.missed} missed.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What this month's alerts did</span>
      <p>
        {sig.length} significant incident{sig.length === 1 ? "" : "s"} (together {pct(sig.reduce((a, i) => a + budgetShare(i), 0), 0)} of the budget) and {blips} day{blips === 1 ? "" : "s"} of blips, at {st.traffic === "busy" ? "1,000 requests a minute" : "10 requests an hour"}.
        {" "}{res.map((r) => `${r.rule.name}: ${r.pages} page${r.pages === 1 ? "" : "s"} (${r.falsePages} false)${r.tickets ? `, ${r.tickets} ticket${r.tickets === 1 ? "" : "s"}` : ""}, ${r.missed} missed`).join(". ")}.
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function BurnRatePlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const res = useMemo(() => evaluate(st.incidents, st.traffic, st.single), [st.incidents, st.traffic, st.single]);
  const hours = useMemo(() => hourly(st.incidents, st.traffic), [st.incidents, st.traffic]);
  const sig = st.incidents.filter(significant).sort((a, b) => span(a)[0] - span(b)[0]);

  return (
    <PgFrame title="One month of errors, three alert rules" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="SLO 99.9% over 30 days. A slow leak fails 0.3% of requests for three days, spending 30% of the month's budget. Which rule never notices it?"
        options={[{ value: "threshold", label: "10 min error rate over the SLO" }, { value: "single", label: "1 h burn rate over 14.4×" }, { value: "multi", label: "Multiwindow, multi-burn-rate" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.ran}
        answer="single"
        explain={<>The 1-hour burn-rate rule. A leak of 0.3% is a burn rate of 3, far under 14.4, so the rule stays silent for three days while 30% of the budget goes. The threshold rule does page, along with every blip. The multiwindow rule opens a ticket about a day in, after 3 days of average burn crosses 1×.</>}
      />

      <div className="pg-card">
        <span className="label">The month · click a day to place an incident</span>
        <div className="br-controls">
          <span className="br-k">Place</span>
          <PgChoice<Tool> label="Incident to place" value={st.tool} onChange={(v) => dispatch({ type: "tool", tool: v })}
            options={[...KINDS.map((k) => ({ value: k as Tool, label: KIND_NAME[k], note: KIND_SPEC[k].note })), { value: "remove" as Tool, label: "Remove" }]} />
          <span className="br-k br-break">Break it</span>
          <PgChoice<Traffic> label="Traffic" value={st.traffic} onChange={(v) => dispatch({ type: "traffic", traffic: v })}
            options={[{ value: "busy", label: "1,000 requests/min" }, { value: "quiet", label: "10 requests/hour" }]} />
        </div>
        <p className="br-note">{st.tool === "remove" ? "Click a day to remove its last incident." : `${KIND_NAME[st.tool]}: ${KIND_SPEC[st.tool].note}.`} Shaded: incidents that spend at least 2% of the budget, the ones worth an alert.</p>
        <RateChart st={st} hours={hours} />
        <DayStrip st={st} onDay={(d) => dispatch({ type: "day", day: d })} />
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "run" })}>{st.ran ? "Alerts are live" : "Run the alert rules over the month"}</PgButton>
          <PgButton onClick={() => dispatch({ type: "clear" })}>Clear the month</PgButton>
        </div>
      </div>

      {st.ran ? (
        <div className="pg-card">
          <span className="label">Alert rules · same data · tall red: page · short amber: ticket · outlined: false page</span>
          {res.map((r) => (
            <div key={r.rule.id} className="br-rule">
              <header>
                <h4>{r.rule.name}</h4>
                <span className="br-cond">{[...r.rule.page.map((c) => `page: ${describeCond(c)}`), ...r.rule.ticket.map((c) => `ticket: ${describeCond(c)}`)].join(" · ")}</span>
                <span className="br-nums"><b className={r.falsePages ? "no" : ""}>{r.pages} pages ({r.falsePages} false)</b> · {r.tickets} tickets · <b className={r.missed ? "no" : ""}>{r.missed} missed</b>{r.medianDetect !== null && <> · median detect {dur(r.medianDetect)}</>}</span>
              </header>
              {r.rule.id === "single" && (
                <div className="br-controls">
                  <span className="br-k">Window</span>
                  <PgChoice<string> label="Window" value={String(st.single.window)} onChange={(v) => dispatch({ type: "window", window: Number(v) as Window })}
                    options={SINGLE_WINDOWS.map((w) => ({ value: String(w), label: windowName(w) }))} />
                  <span className="br-k">Burn rate</span>
                  <PgChoice<string> label="Burn rate threshold" value={String(st.single.burn)} onChange={(v) => dispatch({ type: "burn", burn: Number(v) })}
                    options={SINGLE_BURNS.map((b) => ({ value: String(b), label: `${b}×` }))} />
                </div>
              )}
              <Lane r={r} st={st} reduced={reduced} />
            </div>
          ))}
          {sig.length > 0 && (
            <div className="br-table" role="table" aria-label="Detection of each significant incident">
              <div role="row" className="br-tr head"><span role="columnheader">Incident</span>{res.map((r) => <span key={r.rule.id} role="columnheader">{r.rule.id === "threshold" ? "Threshold" : r.rule.id === "single" ? "One window" : "Multiwindow"}</span>)}</div>
              {sig.map((i) => (
                <div key={i.id} role="row" className="br-tr">
                  <span role="cell">{KIND_NAME[i.kind]}, day {i.day} · {pct(budgetShare(i), 0)}</span>
                  {res.map((r) => { const c = cell(r, i); return <span key={r.rule.id} role="cell" className={c.cls}>{c.text}</span>; })}
                </div>
              ))}
            </div>
          )}
          <dl className="pg-stats">
            {res.map((r) => (
              <div key={r.rule.id} className={r.missed || r.falsePages ? "bad" : ""}>
                <dt>{r.rule.id === "threshold" ? "Threshold" : r.rule.id === "single" ? "One window" : "Multiwindow"}</dt>
                <dd>{r.missed} missed · {r.falsePages} false</dd>
              </div>
            ))}
            <div><dt>Longest reset</dt><dd>{res.map((r) => (r.worstReset === null ? "–" : dur(r.worstReset))).join(" / ")}</dd></div>
          </dl>
        </div>
      ) : (
        <div className="pg-card"><p className="pg-empty">Make your prediction, shape the month if you like, then press Run the alert rules over the month. The default month has a total outage, a partial outage, a three-day slow leak and five days of brief blips.</p></div>
      )}

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="br-ch">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "done" : ""}>{st.done[c.id] ? "✓ " : ""}{c.text}</li>)}
        </ol>
      </div>

      {st.ran && <Result st={st} res={res} />}

      <PgSources links={[
        { title: "the Site Reliability Workbook chapter on alerting on SLOs", href: "https://sre.google/workbook/alerting-on-slos/" },
        { title: "Pyrra's multi-window burn-rate views", href: "https://github.com/pyrra-dev/pyrra" },
        { title: "Sloth's generated SLO alert rules", href: "https://sloth.dev/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.br-controls { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.br-controls .pg-choice { justify-self: start; }
.br-k { font-family: var(--f-code); font-size: .64rem; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
.br-k.br-break { color: var(--pain); }
.br-note { margin: 0; font-size: .85rem; color: var(--ink-2); }
.br-chart, .br-lane { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.br-inc { fill: var(--pain-bg); }
.br-area { fill: var(--accent); fill-opacity: .25; stroke: var(--accent); stroke-width: 1; }
.br-slo { stroke: var(--ink); stroke-width: 1.2; stroke-dasharray: 5 3; }
.br-burn { stroke: var(--pain); stroke-width: 1; stroke-dasharray: 2 3; }
.br-tiny, .br-axis text { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.br-base { stroke: var(--line); }
.br-ep.page { fill: var(--pain); }
.br-ep.ticket { fill: var(--accent); }
.br-ep.false { fill: var(--surface); stroke: var(--pain); stroke-width: 1.4; }
.br-ep.pop { animation: br-pop .3s var(--ease) both; transform-box: fill-box; transform-origin: center; }
@keyframes br-pop { from { opacity: 0; transform: scaleY(.2); } to { opacity: 1; transform: none; } }
.br-days { display: grid; grid-template-columns: repeat(30, minmax(0, 1fr)); gap: 2px; margin-left: ${(PAD / W) * 100}%; margin-right: 1%; }
.br-day { border: 1px solid var(--line); background: var(--surface); padding: 2px 0; min-height: 40px; display: grid; align-content: start; justify-items: center; gap: 1px; font: inherit; color: inherit; cursor: pointer; }
.br-day:hover, .br-day:focus-visible { background: var(--hl); }
.br-dn { font-family: var(--f-code); font-size: .55rem; color: var(--ink-2); }
.br-day i { font-style: normal; font-family: var(--f-code); font-size: .6rem; font-weight: 700; width: 14px; height: 14px; line-height: 14px; text-align: center; background: var(--pain); color: var(--surface); }
.br-day i.k-leak { background: var(--accent); color: var(--accent-ink); }
.br-day i.k-blips { background: var(--surface-2); color: var(--ink); border: 1px solid var(--line); }
.br-rule { display: grid; gap: 4px; padding-bottom: 6px; border-bottom: 1px dashed var(--line); }
.br-rule header { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: baseline; }
.br-rule h4 { margin: 0; font-family: var(--f-code); font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; }
.br-cond { font-size: .8rem; color: var(--ink-2); }
.br-nums { font-family: var(--f-code); font-size: .72rem; }
.br-nums b.no { color: var(--pain); }
.br-table { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); font-size: .82rem; }
.br-tr { display: grid; grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)); gap: 1px; }
.br-tr > span { background: var(--surface); padding: 4px 6px; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.br-tr > span.bad { color: var(--pain); font-weight: 600; }
.br-tr > span.tk { color: var(--accent); }
.br-tr.head > span { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.br-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.br-ch li.done { color: var(--good); }
@media (max-width: 560px) {
  .br-controls { grid-template-columns: 1fr; }
  .br-days { grid-template-columns: repeat(10, minmax(0, 1fr)); margin-left: 0; margin-right: 0; }
  .br-tr { font-size: .72rem; }
}
@media (prefers-reduced-motion: reduce) { .br-ep.pop { animation: none; } }
`;
