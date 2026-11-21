"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  CALLER_NAME, LAYERS, LAYER_JOB, LAYER_NAME, MOVE_AT, OUTAGE, PRICE_PER_CALL, TTLS,
  goals, init, monthly, step, type Breaks, type Layer, type Run, type Ttl,
} from "./model";

/** What every caller's code looks like, in every run. It never changes. */
const CALL: Record<Lang, string> = {
  go: 'rate, err := c.rates.Rate(ctx, "EUR/USD")',
  python: 'rate = self.rates.rate("EUR/USD")',
  typescript: 'const rate = await this.rates.rate("EUR/USD");',
  rust: 'let rate = self.rates.rate("EUR/USD")?;',
};
const TYPE: Record<Lang, string> = { go: "RateSource (interface)", python: "RateSource (Protocol)", typescript: "RateSource (interface)", rust: "RateSource (trait)" };

const money = (x: number) => "$" + Math.round(x).toLocaleString("en-US");
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const chainText = (r: Run) => (r.chain.length ? r.chain.map((l) => LAYER_NAME[l]).join(" → ") : "no proxy");
const breakText = (b: Breaks) => [b.rateMove ? "rate moves" : "", b.outage ? "outage" : ""].filter(Boolean).join(", ");

type Guess = "120" | "60" | "6" | "3";

function Stats({ r }: { r: Run }) {
  return (
    <dl className="pg-stats">
      <div><dt>Vendor calls</dt><dd>{r.vendorCalls}</dd></div>
      <div><dt>Bill / 30 days</dt><dd>{money(monthly(r.vendorCalls))}</dd></div>
      <div><dt>Checkout avg</dt><dd>{r.checkoutAvgMs} ms</dd></div>
      <div><dt>Startup</dt><dd>{r.startupMs} ms</dd></div>
      <div className={r.stale ? "bad" : ""}><dt>Stale answers</dt><dd>{r.stale}</dd></div>
      <div className={r.errors ? "bad" : ""}><dt>Errors</dt><dd>{r.errors}</dd></div>
      <div className={r.unauthorized ? "bad" : ""}><dt>Answers to export</dt><dd>{r.unauthorized}</dd></div>
      <div><dt>Caller lines changed</dt><dd>0</dd></div>
    </dl>
  );
}

function Takeaway({ runs }: { runs: Run[] }) {
  const first = runs[0], r = runs[runs.length - 1];
  const lines: string[] = [];
  if (runs.length > 1)
    lines.push(`Run 1 (${chainText(first)}) made ${n(first.vendorCalls, "vendor call")}, about ${money(monthly(first.vendorCalls))} a month. Run ${r.n} (${chainText(r)}) made ${n(r.vendorCalls, "call")}, about ${money(monthly(r.vendorCalls))} a month, with checkout averaging ${r.checkoutAvgMs} ms. Not one caller line changed between them.`);
  else
    lines.push(`This run made ${n(r.vendorCalls, "vendor call")}, about ${money(monthly(r.vendorCalls))} a month at ${"$" + PRICE_PER_CALL} a call. Now put a proxy on the wire and run the same traffic again.`);
  if (r.chain.includes("guard") && r.unauthorized > 0)
    lines.push(`The cache sits in front of the guard, so it answered the export script ${n(r.unauthorized, "time")} before the guard could say no. Proxies in a chain run in order: put access checks first.`);
  else if (r.stale > 0)
    lines.push(`The price of the cache: ${n(r.stale, "stale answer")}. The callers cannot tell a cached rate from a live one, because the proxy has the same interface. A shorter TTL trades vendor calls for freshness.`);
  else if (r.chain.length && r.errors === 0 && r.breaks.outage)
    lines.push("The vendor went down and no caller noticed: every pair was still fresh in the cache. The proxy hid the outage behind the same interface.");
  return <p className="pg-takeaway">{lines.join(" ")}</p>;
}

export default function ProxyPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const r = st.runs[st.runs.length - 1];
  const g = goals(st.runs);
  const cachedRun = st.runs.find((x) => x.chain.includes("cache") && x.ttl === 60);
  const shelf = LAYERS.filter((l) => !st.chain.includes(l));

  return (
    <PgFrame title="A paid rates API, two minutes of traffic" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="Checkout asks for a rate 120 times in two minutes, across 3 currency pairs. Put a 60 s caching proxy in front of the vendor. How many of those 120 reach the vendor?"
        options={[{ value: "120", label: "120" }, { value: "60", label: "60" }, { value: "6", label: "6" }, { value: "3", label: "3" }]}
        value={guess} onChange={setGuess} revealed={!!cachedRun} answer="6"
        explain={<>The run says {cachedRun?.vendorByCaller.checkout}. Each pair is fetched once, then answered from memory until its 60 s run out: 3 pairs × 2 windows. Checkout&apos;s code did not change; it still calls the same <code>Rate</code> method on the same type.</>}
      />

      <div className="proxy-wire" aria-label="The request path">
        <div className="proxy-node proxy-callers">
          <span className="label">Callers</span>
          <span>{CALLER_NAME.checkout} · 1/s</span>
          <span>{CALLER_NAME.invoices} · 30 at 1:00</span>
          <span>{CALLER_NAME.export} · 40 at 1:30 <em>no scope</em></span>
          <code>{CALL[lang]}</code>
        </div>
        {st.chain.map((l, i) => (
          <div key={l} className={"proxy-node proxy-layer" + (reduced ? "" : " anim")}>
            <span className="label">{i + 1} · {TYPE[lang].split(" ")[0]}</span>
            <b>{LAYER_NAME[l]}</b>
            <span className="muted">{LAYER_JOB[l]}</span>
            {l === "cache" && (
              <PgChoice<`${Ttl}`> label="Cache TTL" value={`${st.ttl}` as `${Ttl}`}
                options={TTLS.map((t) => ({ value: `${t}` as `${Ttl}`, label: `TTL ${t} s` }))}
                onChange={(v) => dispatch({ type: "ttl", ttl: Number(v) as Ttl })} />
            )}
            <div className="pg-actions">
              <PgButton onClick={() => dispatch({ type: "move", layer: l, dir: -1 })} disabled={i === 0} title="Move closer to the callers">← earlier</PgButton>
              <PgButton onClick={() => dispatch({ type: "move", layer: l, dir: 1 })} disabled={i === st.chain.length - 1} title="Move closer to the vendor">later →</PgButton>
              <PgButton onClick={() => dispatch({ type: "remove", layer: l })}>Remove</PgButton>
            </div>
          </div>
        ))}
        <div className="proxy-node proxy-vendor">
          <span className="label">Real subject</span>
          <b>fx vendor client</b>
          <span className="muted">{300} ms a call · {"$" + PRICE_PER_CALL} a call · 800 ms to connect</span>
        </div>
      </div>

      <div className="pg-actions" aria-label="Proxies you can add">
        {shelf.map((l) => (
          <PgButton key={l} onClick={() => dispatch({ type: "add", layer: l })} title={LAYER_JOB[l]}>+ {LAYER_NAME[l]}</PgButton>
        ))}
        <span className="muted proxy-hint">Every proxy implements {TYPE[lang]}, so it can go anywhere on the wire.</span>
      </div>

      <div className="pg-actions" aria-label="Break it">
        <span className="label">Break it</span>
        <button className="pg-btn proxy-break" aria-pressed={st.breaks.rateMove} onClick={() => dispatch({ type: "break", kind: "rateMove" })}>
          {st.breaks.rateMove ? "✓ " : ""}EUR/USD jumps at 0:{MOVE_AT}
        </button>
        <button className="pg-btn proxy-break" aria-pressed={st.breaks.outage} onClick={() => dispatch({ type: "break", kind: "outage" })}>
          {st.breaks.outage ? "✓ " : ""}Vendor down 0:{OUTAGE[0]}–0:{OUTAGE[1]}
        </button>
        <PgButton primary onClick={() => dispatch({ type: "run" })}>Run the 2 minutes ▶</PgButton>
      </div>

      {r ? (
        <div className="pg-result" aria-live="polite">
          <span className="label">Run {r.n} · {chainText(r)}{r.chain.includes("cache") ? ` · TTL ${r.ttl} s` : ""}{breakText(r.breaks) ? ` · ${breakText(r.breaks)}` : ""}</span>
          <Stats r={r} />
          <span className="label">What happened, one of each kind</span>
          <PgLog entries={r.traces} empty="" reduced={reduced} />
          <Takeaway runs={st.runs} />
        </div>
      ) : (
        <p className="pg-empty">Answer the question above, then run the traffic once with no proxy to get a baseline.</p>
      )}

      {st.runs.length > 1 && (
        <div className="proxy-table" role="region" aria-label="Your runs" tabIndex={0}>
          <table>
            <thead><tr><th>Run</th><th>Wire</th><th>Calls</th><th>Bill / 30 d</th><th>Checkout</th><th>Stale</th><th>Errors</th><th>To export</th></tr></thead>
            <tbody>
              {st.runs.slice(-6).map((x) => (
                <tr key={x.n}>
                  <td>{x.n}</td><td>{chainText(x)}{x.chain.includes("cache") ? ` (${x.ttl} s)` : ""}{breakText(x.breaks) ? ` · ${breakText(x.breaks)}` : ""}</td>
                  <td>{x.vendorCalls}</td><td>{money(monthly(x.vendorCalls))}</td><td>{x.checkoutAvgMs} ms</td>
                  <td>{x.stale}</td><td>{x.errors}</td><td>{x.unauthorized}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="proxy-goals">
          <li className={g.cheap ? "done" : ""}>{g.cheap ? "✓" : "○"} Get under 20 vendor calls without touching a caller.</li>
          <li className={g.outage ? "done" : ""}>{g.outage ? "✓" : "○"} Switch on the outage and finish with 0 errors.</li>
          <li className={g.blocked ? "done" : ""}>{g.blocked ? "✓" : "○"} Stop the export script: no vendor calls and no answers for it.</li>
          <li className={g.leak ? "done" : ""}>{g.leak ? "✓" : "○"} Find the order of proxies that leaks rates to the export script even with the guard on.</li>
        </ul>
      </div>

      <PgSources links={[
        { title: "Refactoring.Guru's Proxy", href: "https://refactoring.guru/design-patterns/proxy" },
        { title: "the CDN edge-caching simulator", href: "https://engineersuniverse.com/labs/ai-computing/cloud-computing/content-delivery-network" },
        { title: "the caching tactic explorer", href: "https://dmccreary.github.io/atam/sims/caching-tactic-explorer/" },
      ]} />

      <style>{`
        .proxy-wire { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 18px; position: relative; }
        .proxy-node { border: 1px solid var(--line); background: var(--bg); padding: 8px 10px; display: grid; gap: 4px; align-content: start; min-width: 0; position: relative; font-size: .9rem; }
        .proxy-node + .proxy-node::before { content: "→"; position: absolute; left: -15px; top: 50%; transform: translateY(-50%); color: var(--accent); font-family: var(--f-code); }
        .proxy-node b { font-family: var(--f-code); font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; }
        .proxy-node code { font-size: .68rem; white-space: pre-wrap; word-break: break-word; }
        .proxy-node em { font-style: normal; color: var(--pain); font-family: var(--f-code); font-size: .7rem; text-transform: uppercase; }
        .proxy-layer { border: 1px dashed var(--accent); }
        .proxy-layer.anim { animation: pg-hop .3s var(--ease) both; }
        .proxy-vendor { border-color: var(--ink-2); }
        .proxy-node .muted { font-size: .82rem; }
        .proxy-node .pg-btn { padding: 2px 7px; font-size: .76rem; }
        .proxy-hint { font-size: .85rem; align-self: center; }
        .proxy-break[aria-pressed="true"] { border-color: var(--pain); color: var(--pain); background: var(--pain-bg); }
        .proxy-table { overflow-x: auto; }
        .proxy-table table { border-collapse: collapse; width: 100%; font-size: .8rem; font-family: var(--f-code); }
        .proxy-table th, .proxy-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; white-space: nowrap; }
        .proxy-table th { font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .proxy-goals { list-style: none; padding-left: 0 !important; }
        .proxy-goals li.done { color: var(--good); }
        @media (max-width: 720px) {
          .proxy-wire { grid-auto-flow: row; gap: 14px; }
          .proxy-node + .proxy-node::before { content: "↓"; left: 50%; top: -14px; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) { .proxy-layer.anim { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
