"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CART, CHALLENGES, ENTRIES, ENTRY_LABEL, PREDICT_ANSWER, RULES, SHARED, STYLES, STYLE_LABEL, SUBTOTAL, UPFRONT,
  challengeDone, crossover, dollars, idealCurve, init, linesFor, nextRule, places, predictRevealed, price, pricesOf, rule,
  step, totals, wrongAt, type Action, type Codebase, type Place, type State, type Style,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

const FILES: Record<Lang, Record<Place, string>> = {
  go: { preview: "cart/quote.go", checkout: "checkout/place_order.go", reorder: "orders/reorder.go", invoice: "billing/invoice.go", shared: "pricing/order.go" },
  python: { preview: "cart/quote.py", checkout: "checkout/place_order.py", reorder: "orders/reorder.py", invoice: "billing/invoice.py", shared: "pricing/order.py" },
  typescript: { preview: "cart/quoteCart.ts", checkout: "checkout/placeOrder.ts", reorder: "orders/reorder.ts", invoice: "billing/invoice.ts", shared: "pricing/order.ts" },
  rust: { preview: "cart/quote.rs", checkout: "checkout/place_order.rs", reorder: "orders/reorder.rs", invoice: "billing/invoice.rs", shared: "pricing/order.rs" },
};
const fileOf = (lang: Lang, style: Style, p: Place) => (p === "shared" && style === "db" ? "migrations/*.sql" : FILES[lang][p]);
const SHORT: Record<string, string> = { over100: "10% over $100", coupon: "SPRING10", gold: "Gold 5%", giftcards: "No gift cards", cap: "Cap 20%" };

/* ---------------- where the rule goes ---------------- */

function Places({ st, lang, dispatch }: { st: State; lang: Lang; dispatch: (a: Action) => void }) {
  const c = st.code[st.style];
  const r = nextRule(c);
  return (
    <div className="ld-places">
      {places(st.style).map((p) => {
        const pending = c.pending.includes(p);
        const shared = p === "shared";
        const reach = shared ? SHARED[st.style]!.reaches : [];
        return (
          <button key={p} className={"ld-place" + (shared ? " shared" : "") + (pending ? " pending" : "")}
            aria-pressed={pending} disabled={!r} onClick={() => dispatch({ type: "place", place: p })}>
            <span className="ld-ptitle">{shared ? SHARED[st.style]!.label : ENTRY_LABEL[p as keyof typeof ENTRY_LABEL]}</span>
            <span className="ld-file">{fileOf(lang, st.style, p)}</span>
            {shared && <span className="ld-reach">used by {reach.map((e) => ENTRY_LABEL[e]).join(", ")}</span>}
            <span className="ld-chips">
              {c.placed[p].map((id) => <code key={id}>{SHORT[id]}</code>)}
              {pending && r && <code className="new">+ {SHORT[r.id]} · {n(linesFor(st.style, r, p, c.placed[p].length), "line")}</code>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Prices({ st }: { st: State }) {
  const c = st.code[st.style];
  const p = pricesOf(st.style, c);
  const want = price(c.shipped.map((x) => x.rule));
  const wrong = wrongAt(st.style, c);
  return (
    <div className="pg-card">
      <span className="label">The same cart, priced at each entry point</span>
      <p className="ld-cart">
        {CART.map((l) => `${l.name} ${dollars(l.cents)}`).join(" · ")}. Gold member, coupon SPRING10. Subtotal {dollars(SUBTOTAL)}.
      </p>
      <ul className="ld-prices">
        {ENTRIES.map((e) => (
          <li key={e} className={wrong.includes(e) ? "bad" : ""}>
            <span>{ENTRY_LABEL[e]}</span><b>{dollars(p[e])}</b>
          </li>
        ))}
      </ul>
      <p className={wrong.length ? "ld-bad" : "ld-good"} aria-live="polite">
        {c.shipped.length === 0
          ? "No rules yet: everyone pays the subtotal."
          : wrong.length
            ? `The rules say ${dollars(want)}. ${wrong.map((e) => ENTRY_LABEL[e]).join(", ")} ${wrong.length === 1 ? "charges or shows" : "charge or show"} something else, so a customer sees one price and pays another.`
            : `Every entry point agrees on ${dollars(want)}.`}
      </p>
    </div>
  );
}

/* ---------------- the cost curves ---------------- */

const COLOR: Record<Style, string> = { script: "var(--pain)", domain: "var(--accent)", db: "var(--ink-2)" };

function Chart({ st }: { st: State }) {
  const K = Math.max(...STYLES.map((s) => st.code[s].shipped.length));
  const W = 560, H = 190, L = 34, R = 10, T = 12, B = 26;
  const maxY = 100;
  const x = (k: number) => L + (k / RULES.length) * (W - L - R);
  const y = (v: number) => T + (1 - v / maxY) * (H - T - B);
  return (
    <figure className="ld-chartbox">
      <svg className="ld-chart" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Lines written after each rule, for the three styles, up to rule ${K}.`}>
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line className="ld-gridline" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text className="ld-tick" x={L - 4} y={y(v) + 3} textAnchor="end">{v}</text>
          </g>
        ))}
        {RULES.map((r, i) => (
          <text key={r.id} className="ld-tick" x={x(i + 1)} y={H - 8} textAnchor="middle">rule {i + 1}</text>
        ))}
        {STYLES.map((s) => {
          const pts = idealCurve(s).slice(0, K + 1);
          return (
            <g key={s}>
              <polyline className="ld-curve" style={{ stroke: COLOR[s] }} points={pts.map((v, k) => `${x(k)},${y(v)}`).join(" ")} />
              {pts.map((v, k) => <circle key={k} className="ld-dot" style={{ fill: COLOR[s] }} cx={x(k)} cy={y(v)} r={s === st.style ? 4 : 2.5} />)}
            </g>
          );
        })}
        {K === 0 && <text className="ld-tick" x={W / 2} y={H / 2} textAnchor="middle">ship a rule to draw the curves</text>}
      </svg>
      <figcaption className="ld-legend">
        {STYLES.map((s) => <span key={s} style={{ borderColor: COLOR[s] }}>{STYLE_LABEL[s]} · {idealCurve(s)[K]} lines</span>)}
        <span className="ld-note">Lines written so every entry point gets every rule, counting {UPFRONT.domain} up front for the domain model and {UPFRONT.db} for the SQL function.</span>
      </figcaption>
    </figure>
  );
}

function History({ c, lang, style }: { c: Codebase; lang: Lang; style: Style }) {
  if (!c.shipped.length) return null;
  return (
    <ol className="ld-history">
      {c.shipped.map((x) => (
        <li key={x.rule}>
          <b>{rule(x.rule).title}</b>{" "}
          <span>{n(x.places.length, "file")} ({x.places.map((p) => fileOf(lang, style, p)).join(", ")}) · {n(x.lines, "line")}{x.migrations ? " · 1 migration" : ""}</span>
        </li>
      ))}
    </ol>
  );
}

function Result({ st }: { st: State }) {
  const tried = STYLES.filter((s) => st.code[s].shipped.length > 0);
  if (!tried.length) return null;
  const k = crossover();
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your rules cost</span>
      {tried.map((s) => {
        const c = st.code[s], t = totals(s, c), wrong = wrongAt(s, c);
        return (
          <p key={s}>
            <b>{STYLE_LABEL[s]}:</b> {n(t.rules, "rule")} in {n(t.edits, "file edit")}, {t.lines} lines in all{s === "domain" ? `, ${UPFRONT.domain} of them up front` : ""}
            {t.migrations ? `, ${n(t.migrations, "migration")}, ${n(t.dbTests, "rule")} that can only be tested against Postgres` : ""}.
            {" "}{wrong.length ? `${n(wrong.length, "entry point")} ${wrong.length === 1 ? "prices" : "price"} the cart wrong.` : "Every price is right."}
          </p>
        );
      })}
      <p className="pg-takeaway">
        Scripts are cheapest while rules are few and independent. Each rule is written once per script, and a rule that changes the others is paid again in every copy, so by rule {k} the domain model, with one place per rule, has cost less. Putting the rule in the database keeps one copy only for the code that can reach a row.
      </p>
    </div>
  );
}

export default function LayeringPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch } = useModel(step, init);
  const c = st.code[st.style];
  const r = nextRule(c);
  const t = totals(st.style, c);
  const wrong = wrongAt(st.style, c);

  return (
    <PgFrame title="One discount rule, three homes" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p>Four screens price the same cart. Five discount rules arrive one at a time. For each, click every place you will write it, then ship, and watch what each screen charges. Each style keeps its own codebase, so you can ship the same rules three ways and compare.</p>
      </div>

      <PgPredict
        question="Transaction scripts are cheaper to write at first. After which rule has the domain model cost fewer lines in total?"
        options={[{ value: "1", label: "Rule 1" }, { value: "2", label: "Rule 2" }, { value: "4", label: "Rule 4" }, { value: "never", label: "Never" }]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={predictRevealed(st)}
        answer={PREDICT_ANSWER}
        explain={<>Rule {crossover()}. The domain model starts {UPFRONT.domain} lines behind. Scripts pay each rule four times, and the gift-card exclusion has to rework every rule already in each script, so that is where the curves cross.</>}
      />

      <div className="ld-style">
        <span className="label">Where the pricing logic lives</span>
        <PgChoice<Style> label="Where the pricing logic lives" value={st.style}
          options={STYLES.map((s) => ({ value: s, label: `${STYLE_LABEL[s]}${st.code[s].shipped.length ? ` · ${st.code[s].shipped.length}/5` : ""}` }))}
          onChange={(s) => dispatch({ type: "style", style: s })} />
      </div>

      <div className="pg-card">
        {r ? (
          <>
            <span className="label">Change request {c.shipped.length + 1} of {RULES.length} · from {r.who}</span>
            <p className="ld-rule">{r.title}{r.interacts ? <span> It changes how the rules already written work.</span> : null}</p>
            <p className="ld-hint">Click each place you will write it.{st.style !== "script" ? " The shared box reaches the screens listed on it." : ""}</p>
          </>
        ) : (
          <>
            <span className="label">All five rules shipped as {STYLE_LABEL[st.style].toLowerCase()}</span>
            <p className="ld-hint">Switch style to ship them again another way, or start this style over.</p>
          </>
        )}
        <Places st={st} lang={lang} dispatch={dispatch} />
        <div className="pg-actions">
          <PgButton primary disabled={!r || c.pending.length === 0} onClick={() => dispatch({ type: "ship" })}>
            {r ? `Ship it to ${n(c.pending.length, "place")}` : "Nothing left to ship"}
          </PgButton>
          <PgButton disabled={!c.shipped.length} onClick={() => dispatch({ type: "undoStyle" })}>Start this style over</PgButton>
        </div>
      </div>

      <div className="pg-grid">
        <Prices st={st} />
        <div className="pg-card">
          <span className="label">Where the changes landed</span>
          <dl className="pg-stats">
            <div><dt>Lines</dt><dd>{t.lines}</dd></div>
            <div><dt>File edits</dt><dd>{t.edits}</dd></div>
            <div className={t.dbTests ? "bad" : ""}><dt>Tests need Postgres</dt><dd>{t.dbTests}</dd></div>
            <div className={wrong.length ? "bad" : ""}><dt>Wrong prices</dt><dd>{wrong.length}</dd></div>
          </dl>
          {c.shipped.length ? <History c={c} lang={lang} style={st.style} /> : <p className="pg-empty">Nothing shipped in this style yet.</p>}
        </div>
      </div>

      <Chart st={st} />

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="ld-ch">
          {CHALLENGES.map((ch) => (
            <li key={ch.id} className={challengeDone(st, ch.id) ? "done" : ""}>{challengeDone(st, ch.id) ? "✓ " : ""}{ch.text}</li>
          ))}
        </ol>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Fowler's Transaction Script", href: "https://martinfowler.com/eaaCatalog/transactionScript.html" },
        { title: "Fowler's Domain Model", href: "https://martinfowler.com/eaaCatalog/domainModel.html" },
        { title: "the Anemic Domain Model bliki entry", href: "https://martinfowler.com/bliki/AnemicDomainModel.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.ld-style { display: grid; gap: 4px; }
.ld-rule { margin: 0; font-size: 1.05rem; font-weight: 600; }
.ld-rule span { font-weight: 400; color: var(--pain); font-size: .92rem; }
.ld-hint { margin: 0; font-size: .9rem; color: var(--ink-2); }
.ld-places { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.ld-place { display: grid; gap: 3px; align-content: start; text-align: left; border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; color: var(--ink); min-height: 74px; transition: border-color .2s var(--ease), background .2s var(--ease); }
.ld-place.shared { border-style: dashed; border-color: var(--accent); grid-column: 1 / -1; }
.ld-place.pending { border-color: var(--accent); background: var(--hl); border-style: solid; border-width: 2px; }
.ld-place:disabled { opacity: .7; cursor: default; }
.ld-ptitle { font-family: var(--f-code); font-size: .7rem; letter-spacing: .06em; text-transform: uppercase; }
.ld-file { font-family: var(--f-code); font-size: .66rem; color: var(--ink-2); overflow-wrap: anywhere; }
.ld-reach { font-size: .78rem; color: var(--accent); }
.ld-chips { display: flex; flex-wrap: wrap; gap: 3px; }
.ld-chips code { font-size: .64rem; }
.ld-chips code.new { background: var(--good-bg); color: var(--good); }
.ld-cart { margin: 0; font-size: .85rem; color: var(--ink-2); }
.ld-prices { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
.ld-prices li { display: flex; justify-content: space-between; gap: 6px; border: 1px solid var(--line); background: var(--surface); padding: 4px 8px; font-size: .88rem; }
.ld-prices li b { font-family: var(--f-code); font-variant-numeric: tabular-nums; }
.ld-prices li.bad { border-color: var(--pain); background: var(--pain-bg); }
.ld-bad { margin: 0; color: var(--pain); font-size: .92rem; }
.ld-good { margin: 0; color: var(--good); font-size: .92rem; }
.ld-history { margin: 0; padding-left: 1.2em; display: grid; gap: 3px; font-size: .84rem; }
.ld-history span { color: var(--ink-2); overflow-wrap: anywhere; }
.ld-chartbox { margin: 0; display: grid; gap: 6px; }
.ld-chart { width: 100%; height: auto; display: block; border: 1px solid var(--line); background: var(--bg); }
.ld-gridline { stroke: var(--grid); stroke-width: 1; }
.ld-tick { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.ld-curve { fill: none; stroke-width: 2; }
.ld-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: .8rem; color: var(--ink-2); }
.ld-legend span { border-left: 4px solid; padding-left: 6px; }
.ld-legend .ld-note { border: 0; padding: 0; flex-basis: 100%; }
.ld-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.ld-ch li.done { color: var(--good); }
@media (max-width: 480px) { .ld-prices { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .ld-place { transition: none; } }
`;
