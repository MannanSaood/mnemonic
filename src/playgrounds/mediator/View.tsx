"use client";
import { useState, type KeyboardEvent } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ADDONS, ADDON_INFO, GOD_OBJECT_RULES, LOOP_LIMIT, NAME, init, mediatorLinks, possiblePairs, redundant, step, wiredLinks,
  type Comp, type Run, type Side, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
/** Display-only components: they react, the customer does not change them. */
const OUTPUTS: Comp[] = ["summary", "placeOrder"];
const W = 320, H = 270, CX = 160, CY = 135, R = 108, BW = 74, BH = 22;

function positions(comps: Comp[]) {
  return Object.fromEntries(comps.map((c, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / comps.length;
    return [c, { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) }];
  })) as Record<Comp, { x: number; y: number }>;
}

function Graph({ st, side, onPick, reduced }: { st: State; side: Side; onPick: (c: Comp) => void; reduced: boolean }) {
  const pos = positions(st.comps);
  const run: Run | undefined = st.last?.[side];
  const hotIndex = new Map<string, number>();
  run?.hops.forEach((h, i) => { const k = `${h.from}>${h.to}`; if (!hotIndex.has(k)) hotIndex.set(k, i); });
  const at = (c: Comp | "mediator") => (c === "mediator" ? { x: CX, y: CY } : pos[c]);
  const edges: [Comp | "mediator", Comp | "mediator"][] = side === "wired"
    ? st.calls
    : st.comps.flatMap((c) => [[c, "mediator"], ["mediator", c]] as [Comp | "mediator", Comp | "mediator"][]);
  const key = (e: KeyboardEvent, c: Comp) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(c); } };
  return (
    <svg className="mediator-svg" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={side === "wired" ? "Components wired to each other" : "Components connected through a mediator"}>
      <defs>
        <marker id={`mediator-arrow-${side}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 z" style={{ fill: "var(--ink-2)" }} />
        </marker>
      </defs>
      {edges.map(([f, t]) => {
        const a = at(f), b = at(t);
        const i = hotIndex.get(`${f}>${t}`);
        const hot = i !== undefined;
        // Offset paired edges slightly so both directions show.
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ox = (-dy / len) * 3, oy = (dx / len) * 3;
        const shrink = 14 / len;
        const x1 = a.x + dx * shrink + ox, y1 = a.y + dy * shrink + oy, x2 = b.x - dx * shrink + ox, y2 = b.y - dy * shrink + oy;
        return (
          <g key={`${f}>${t}`}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} markerEnd={side === "wired" ? `url(#mediator-arrow-${side})` : undefined}
              className={hot ? "mediator-hot" : "mediator-edge"} style={hot && !reduced ? { animationDelay: `${i * 90}ms` } : undefined} />
            {hot && <text x={(x1 + x2) / 2 + ox * 2} y={(y1 + y2) / 2 + oy * 2} className="mediator-step">{i + 1}</text>}
          </g>
        );
      })}
      {side === "mediator" && (
        <g>
          <rect x={CX - 40} y={CY - 13} width={80} height={26} className="mediator-hub" />
          <text x={CX} y={CY + 4} textAnchor="middle" className="mediator-label hub">Mediator</text>
        </g>
      )}
      {st.comps.map((c) => {
        const p = pos[c];
        const k = run?.updates[c] ?? 0;
        const input = !OUTPUTS.includes(c);
        const src = run?.source === c;
        return (
          <g key={c} className={"mediator-node" + (input ? " input" : "") + (src ? " src" : "")}
            {...(input ? { role: "button", tabIndex: 0, "aria-label": `Customer changes ${NAME[c]}`, onClick: () => onPick(c), onKeyDown: (e: KeyboardEvent) => key(e, c) } : {})}>
            <rect x={p.x - BW / 2} y={p.y - BH / 2} width={BW} height={BH} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" className="mediator-label">{NAME[c]}</text>
            {k > 0 && (
              <g>
                <rect x={p.x + BW / 2 - 16} y={p.y - BH / 2 - 9} width={22} height={13} className={k > 1 ? "mediator-badge bad" : "mediator-badge"} />
                <text x={p.x + BW / 2 - 5} y={p.y - BH / 2 + 1} textAnchor="middle" className="mediator-badge-text">×{k}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Stats({ st, side }: { st: State; side: Side }) {
  const run = st.last?.[side];
  const files = st.costs.reduce((s, c) => s + (side === "wired" ? c.wiredFiles.length : c.mediatorFiles.length), 0);
  return (
    <dl className="pg-stats">
      <div><dt>Links</dt><dd>{side === "wired" ? wiredLinks(st.calls) : mediatorLinks(st.comps)}</dd></div>
      <div className={run?.loop ? "bad" : ""}><dt>Calls, last click</dt><dd>{run ? (run.loop ? `${LOOP_LIMIT}+ loop` : run.hops.length) : "–"}</dd></div>
      <div className={run && redundant(run) ? "bad" : ""}><dt>Stale re-renders</dt><dd>{run ? redundant(run) : "–"}</dd></div>
      {side === "wired"
        ? <div className={files ? "bad" : ""}><dt>Existing files edited</dt><dd>{files}</dd></div>
        : <div className={st.rules > GOD_OBJECT_RULES ? "bad" : ""}><dt>Mediator rules</dt><dd>{st.rules}</dd></div>}
    </dl>
  );
}

function RunLog({ run }: { run: Run | undefined }) {
  if (!run) return <p className="pg-empty">Click a component to change it, as a customer would.</p>;
  if (!run.hops.length) return <p className="pg-empty">Nothing else depends on {NAME[run.source]}.</p>;
  const label = (c: Comp | "mediator") => (c === "mediator" ? "mediator" : NAME[c]);
  return (
    <ol className="mediator-log">
      {run.hops.slice(0, 12).map((h, i) => <li key={i}>{label(h.from)} → {label(h.to)}</li>)}
      {run.hops.length > 12 && <li className="bad">… {run.loop ? "and on and on: a loop" : `${run.hops.length - 12} more`}</li>}
    </ol>
  );
}

type Guess = "0" | "1" | "4";

export default function MediatorPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const pick = (comp: Comp) => dispatch({ type: "change", comp });
  const revealed = st.comps.includes("giftCard");
  const inputs = st.comps.filter((c) => !OUTPUTS.includes(c));
  const last = st.last;
  const wiredFiles = st.costs.reduce((s, c) => s + c.wiredFiles.length, 0);

  return (
    <PgFrame title="One checkout page, wired two ways" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="Product wants a gift card field on the checkout. In the page where components call each other directly, how many existing components' code must change?"
        options={[{ value: "0", label: "None, it is a new component" }, { value: "1", label: "One" }, { value: "4", label: "Four" }]}
        value={guess} onChange={setGuess} revealed={revealed} answer="4"
        explain={<>Summary, Payment and Place order must each accept the gift card's input, and Cart must now call the gift card when the basket changes. In the mediator design, those reactions live in the mediator, so only that one file changes.</>}
      />

      <div className="pg-req">
        <span className="label">The customer changes</span>
        <div className="pg-actions">
          {inputs.map((c) => <PgButton key={c} onClick={() => pick(c)}>{NAME[c]}</PgButton>)}
        </div>
        <p className="muted mediator-small">Or click a component in either diagram. Both pages get the same action. A badge shows how many times a component re-rendered; more than once means the customer briefly saw stale numbers.</p>
      </div>

      <div className="pg-sides">
        {(["wired", "mediator"] as Side[]).map((d) => (
          <section key={d} className="pg-side" aria-label={d === "wired" ? "Wired directly" : "Through a mediator"}>
            <header>
              <h4>{d === "wired" ? "Wired to each other" : "Through a mediator"}</h4>
              <span className={"pg-status" + (last?.[d].loop ? "" : " done")}>{last?.[d].loop ? "Loop" : ""}</span>
            </header>
            <p className="muted mediator-small">{d === "wired" ? "Each component holds the others it must update and calls them." : "Each component tells the mediator. The mediator updates the rest, once each."}</p>
            <Graph st={st} side={d} onPick={pick} reduced={reduced} />
            <Stats st={st} side={d} />
            <span className="label">Calls, in order</span>
            <RunLog run={last?.[d]} />
          </section>
        ))}
      </div>

      <div className="pg-req">
        <span className="label">Change requests</span>
        <ul className="pg-places">
          {ADDONS.map((a) => {
            const cost = st.costs.find((c) => c.addon === a);
            return (
              <li key={a}>
                <span className="pg-place">{NAME[a]}</span>
                <span className="mediator-small">
                  {cost
                    ? <>Wired: edited <b>{cost.wiredFiles.map((c) => NAME[c]).join(", ")}</b> ({n(cost.wiredFiles.length, "file")}), +{n(cost.newLinksWired, "link")}. Mediator: edited <b>the mediator</b>, +{n(cost.mediatorRules, "rule")}.</>
                    : ADDON_INFO[a].why}
                </span>
                {!cost && <PgButton onClick={() => dispatch({ type: "add", addon: a })}>Add</PgButton>}
              </li>
            );
          })}
        </ul>
        {st.comps.includes("loyalty") && <p className="mediator-small"><b>Try:</b> change Promo code or Loyalty points now. Each one clears the other.</p>}
      </div>

      {(st.clicks > 0 || st.costs.length > 0) && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your checkout shows</span>
          <p>
            {n(st.comps.length, "component")}, {possiblePairs(st.comps.length)} possible pairs. Wired: {n(wiredLinks(st.calls), "link")}, {n(wiredFiles, "existing file")} edited by your change requests
            {st.clicks ? <>, {n(st.redundantSeen, "stale re-render")} and {n(st.loopsSeen, "loop")} over your {n(st.clicks, "click")}</> : null}.
            {" "}Mediator: {n(mediatorLinks(st.comps), "link")}, one file edited per request, no stale re-renders, and {n(st.rules, "rule")} in the mediator.
          </p>
          <p className="pg-takeaway">
            {st.rules > GOD_OBJECT_RULES
              ? `The mediator now holds ${st.rules} rules, more than any component. That is the price: the tangle is gone from the components and has moved into one place. Split it by flow (pricing, payment, delivery) before it becomes the class everyone is afraid to touch.`
              : "Direct links grow with every pair of components that must cooperate, and each new component edits the ones it touches. A mediator keeps each component to one link and puts the cooperation in one place, where the order of updates is decided once."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "refactoring.guru on Mediator", href: "https://refactoring.guru/design-patterns/mediator" },
        { title: "Wikipedia's Mediator pattern article", href: "https://en.wikipedia.org/wiki/Mediator_pattern" },
      ]} />

      <style>{`
        .mediator-small { font-size: .9rem; margin: 0; }
        .mediator-svg { width: 100%; height: auto; background: var(--surface); border: 1px solid var(--line); }
        .mediator-edge { stroke: var(--line); stroke-width: 1; }
        .mediator-hot { stroke: var(--accent); stroke-width: 2.2; animation: mediator-in .3s var(--ease) both; }
        @keyframes mediator-in { from { opacity: 0; } to { opacity: 1; } }
        .mediator-step { font-family: var(--f-code); font-size: 9px; fill: var(--accent); font-weight: 700; }
        .mediator-node rect { fill: var(--bg); stroke: var(--line); }
        .mediator-node.input { cursor: pointer; }
        .mediator-node.input rect { stroke: var(--ink-2); }
        .mediator-node.input:hover rect, .mediator-node.input:focus rect { stroke: var(--accent); stroke-width: 2; }
        .mediator-node:focus { outline: none; }
        .mediator-node.src rect { fill: var(--accent); stroke: var(--accent); }
        .mediator-node.src .mediator-label { fill: var(--accent-ink); }
        .mediator-label { font-family: var(--f-code); font-size: 8.5px; text-transform: uppercase; letter-spacing: .03em; fill: var(--ink); pointer-events: none; }
        .mediator-hub { fill: var(--hl); stroke: var(--accent); stroke-dasharray: 4 2; }
        .mediator-badge { fill: var(--good-bg); stroke: var(--good); }
        .mediator-badge.bad { fill: var(--pain-bg); stroke: var(--pain); }
        .mediator-badge-text { font-family: var(--f-code); font-size: 8px; fill: var(--ink); font-weight: 700; }
        .mediator-log { margin: 0; padding-left: 1.8em; font-family: var(--f-code); font-size: .72rem; display: grid; gap: 1px; max-height: 200px; overflow: auto; }
        .mediator-log li.bad { color: var(--pain); }
        @media (prefers-reduced-motion: reduce) { .mediator-hot { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
