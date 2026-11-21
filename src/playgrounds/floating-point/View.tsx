"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  AMOUNTS, CHALLENGES, LAYOUT, MAX_ADDS, STARTS,
  amountOf, drift, equal, exactDecimal, fields, formatCents, gap, init, recovered, shortest, startOf, step, valueOf,
  type Action, type AmountKey, type Col, type Prediction, type StartKey, type State, type Width,
} from "./model";

const TYPES: Record<Lang, { f64: string; f32: string; int: string; exactNote: string }> = {
  go: { f64: "float64", f32: "float32", int: "int64 cents", exactNote: "Go has no decimal type in the standard library; count cents in int64." },
  python: { f64: "float", f32: "numpy.float32", int: "int cents", exactNote: "Python ints never overflow; decimal.Decimal is the other exact choice." },
  typescript: { f64: "number", f32: "Math.fround", int: "integer cents", exactNote: "A number holds whole cents exactly up to 2^53; use bigint beyond that." },
  rust: { f64: "f64", f32: "f32", int: "i64 cents", exactNote: "i64 cents is exact; the rust_decimal crate is the decimal choice." },
};

const fmtDrift = (c: number) => {
  if (!Number.isFinite(c)) return "–";
  if (c === 0) return "0";
  const a = Math.abs(c);
  const s = a >= 100 ? a.toLocaleString("en-US", { maximumFractionDigits: 0 }) : a >= 0.01 ? a.toPrecision(3) : a.toExponential(1);
  return (c > 0 ? "+" : "−") + s;
};
const clip = (s: string, n = 64) => (s.length > n ? s.slice(0, n) + "…" : s);

function Column({ st, col, name, dispatch }: { st: State; col: Col; name: string; dispatch: (a: { type: "inspectTotal"; col: Col }) => void }) {
  const w: Width = col === "f64" ? 64 : 32;
  const ok = equal(st, col);
  const d = drift(st, col);
  const rec = recovered(st, col);
  const dep = Number(amountOf(st.amount).cents) / 100;
  return (
    <div className={"pg-side fp-col" + (ok ? "" : " off")}>
      <header><h4>{name}</h4><span className={"pg-status" + (ok ? " done" : "")}>{ok ? "== exact" : "!= exact"}</span></header>
      <button className="fp-total" onClick={() => dispatch({ type: "inspectTotal", col })} title="Show the bits of this total in the inspector">
        {shortest(st.totals[col], w)}
      </button>
      <dl className="pg-stats fp-stats">
        <div className={Math.abs(d) >= 1 ? "bad" : ""}><dt>Drift · cents</dt><dd>{fmtDrift(d)}</dd></div>
        <div className={rec !== null && rec !== dep ? "bad" : ""}><dt>Last deposit, recovered</dt><dd>{rec === null ? "–" : shortest(rec, w)}</dd></div>
      </dl>
      <p className="muted fp-small">{st.lastIgnored32 && col === "f32" ? "The last add changed nothing: the cent was smaller than half the gap." : `Gap to the next ${name} here: ${shortest(gap(st.totals[col], w), w)}`}</p>
    </div>
  );
}

function Inspector({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const [text, setText] = useState("0.1 + 0.2");
  const { width, bits } = st.insp;
  const L = LAYOUT[width];
  const x = valueOf(bits, width);
  const f = fields(bits, width);
  const g = Number.isFinite(x) ? gap(x, width) : NaN;
  const cls = (i: number) => (i === width - 1 ? "s" : i >= L.frac ? "e" : "m");
  const order = Array.from({ length: width }, (_, k) => width - 1 - k);
  const hexDigits = L.frac / 4 + (L.frac % 4 ? 1 : 0);
  const formula = f.kind === "normal"
    ? `(−1)^${f.sign} × 1.${f.frac.toString(16).padStart(hexDigits, "0")}₁₆ × 2^${f.unbiased}`
    : f.kind === "subnormal" ? `(−1)^${f.sign} × 0.${f.frac.toString(16).padStart(hexDigits, "0")}₁₆ × 2^${f.unbiased} (subnormal)`
    : f.kind === "zero" ? (f.sign ? "negative zero" : "zero")
    : f.kind === "infinity" ? "exponent all ones, mantissa zero: infinity"
    : "exponent all ones, mantissa not zero: NaN, which is not equal even to itself";
  return (
    <div className="pg-card">
      <span className="label">Bit inspector · click any bit to flip it</span>
      <div className="fp-bar">
        <PgChoice<"32" | "64"> label="Width" value={String(width) as "32" | "64"} onChange={(v) => dispatch({ type: "width", value: Number(v) as Width })}
          options={[{ value: "32", label: "float32" }, { value: "64", label: "float64" }]} />
        <form className="fp-form" onSubmit={(e) => { e.preventDefault(); dispatch({ type: "enter", text }); }}>
          <label className="pg-place" htmlFor="fp-in">Value</label>
          <input id="fp-in" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <button className="pg-btn primary" type="submit">Store it</button>
        </form>
      </div>
      <div className="fp-chips">
        {["0.1", "0.1 + 0.2", "0.3", "2^24 + 1", "1e16 + 1", "nan"].map((s) => (
          <button key={s} className="pg-btn" onClick={() => { setText(s); dispatch({ type: "enter", text: s }); }}>{s}</button>
        ))}
      </div>
      {st.insp.error && <p className="fp-err">{st.insp.error}</p>}
      <div className={"fp-bits w" + width} role="group" aria-label={`${width} bits: 1 sign, ${L.exp} exponent, ${L.frac} mantissa`}>
        {order.map((i) => {
          const on = ((bits >> BigInt(i)) & 1n) === 1n;
          return (
            <button key={i} className={`fp-bit ${cls(i)}${on ? " on" : ""}`} onClick={() => dispatch({ type: "toggleBit", i })}
              aria-label={`bit ${i}, ${cls(i) === "s" ? "sign" : cls(i) === "e" ? "exponent" : "mantissa"}, ${on ? 1 : 0}`} aria-pressed={on}>
              {on ? 1 : 0}
            </button>
          );
        })}
      </div>
      <p className="fp-legend"><span className="s">sign 1</span><span className="e">exponent {L.exp} (bias {L.bias})</span><span className="m">mantissa {L.frac}</span></p>
      <dl className="pg-stats fp-read">
        <div><dt>Prints as</dt><dd>{shortest(x, width)}</dd></div>
        <div><dt>Exponent field</dt><dd>{f.exp} → 2^{f.unbiased}</dd></div>
        <div className={g > 0.01 ? "bad" : ""}><dt>Gap to next float</dt><dd>{Number.isFinite(g) ? shortest(g, width) : "–"}</dd></div>
        <div><dt>From</dt><dd>{clip(st.insp.source, 18)}</dd></div>
      </dl>
      <p className="fp-formula"><code>{formula}</code></p>
      <p className="fp-exact"><span className="pg-place">Exactly stored</span> <code>{clip(exactDecimal(x), 80)}</code></p>
      <p className="muted fp-small">
        {g > 0.01
          ? `Neighbouring ${width === 64 ? "float64" : "float32"} values here are ${shortest(g, width)} apart. Any amount under half of that, like a cent, rounds away completely.`
          : f.kind === "normal" && exactDecimal(x) !== shortest(x, width)
            ? "The printed value is the shortest decimal that rounds back to these bits. The bits hold the long number: the nearest binary fraction to what you typed."
            : "This value is a sum of powers of two, so the bits hold it exactly."}
      </p>
    </div>
  );
}

function Result({ st, T }: { st: State; T: (typeof TYPES)[Lang] }) {
  const d64 = drift(st, "f64"), d32 = drift(st, "f32");
  const amt = amountOf(st.amount).label;
  let take: string;
  if (st.lastIgnored32 || Math.abs(d32) >= 100)
    take = `At this size the gap between neighbouring float32 values is ${shortest(gap(st.totals.f32, 32), 32)}, so a ${amt} add rounds to a multiple of that gap or to nothing. Floats keep about 7 (float32) or 16 (float64) significant digits wherever the decimal point falls; a large balance spends them on the dollars.`;
  else if (Math.abs(d64) >= 1)
    take = `Even float64 is now off by ${fmtDrift(d64)} cents. Each add rounded the same way, so the errors did not cancel; they piled up.`;
  else
    take = `None of 0.10, 0.20 or 0.01 has an exact binary form, so every add stores the nearest binary fraction and rounds the sum again. The errors are tiny but real, and an equality check against the exact total fails.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your ledger shows</span>
      <p>{st.adds.toLocaleString("en-US")} adds of {amt} from {startOf(st.start).label}. Exact total {formatCents(st.totals.cents)}. {T.f64} is off by {fmtDrift(d64)} cents, {T.f32} by {fmtDrift(d32)} cents, {T.int} by 0.</p>
      <p className="pg-takeaway">{take} Keep money in integer minor units or a decimal type, and convert to a float only for display or statistics. {T.exactNote}</p>
    </div>
  );
}

export default function FloatingPointPlayground() {
  const { lang } = usePrefs();
  const T = TYPES[lang];
  const { state: st, dispatch } = useModel(step, init);
  const revealed = st.adds >= 10;

  return (
    <PgFrame title="A ledger that adds money three ways" onReset={() => dispatch({ type: "reset" })}>
      <PgPredict<Prediction>
        question="Start at $0 and add $0.10 ten times in a float64. Then compare the total with $1.00. What happens?"
        options={[{ value: "exact", label: "Equal: the total is exactly 1" }, { value: "tiny", label: "Not equal: off by a tiny amount" }, { value: "cent", label: "Off by a whole cent" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={revealed}
        answer="tiny"
        explain={<>Ten adds of $0.10 from $0 give 0.9999999999999999, about 1.1 × 10⁻¹⁴ cents short. 0.1 is a repeating fraction in binary (like 1/3 in decimal), so the float holds the nearest binary fraction, and each sum rounds again. Tiny, but <code>total == 1.00</code> is false.</>}
      />

      <div className="pg-req">
        <span className="label">The ledger · {st.adds.toLocaleString("en-US")} adds</span>
        <div className="fp-rows">
          <span className="pg-place">Opening balance</span>
          <PgChoice<StartKey> label="Opening balance" value={st.start} onChange={(v) => dispatch({ type: "start", value: v })}
            options={STARTS.map((s) => ({ value: s.value, label: s.label, note: s.note }))} />
          <span className="pg-place">Each add</span>
          <PgChoice<AmountKey> label="Amount per add" value={st.amount} onChange={(v) => dispatch({ type: "amount", value: v })}
            options={AMOUNTS.map((a) => ({ value: a.value, label: a.label }))} />
        </div>
        <div className="pg-actions">
          {[1, 10, 1000, 1_000_000].map((n) => (
            <PgButton key={n} primary={n === 10} disabled={st.adds >= MAX_ADDS} onClick={() => dispatch({ type: "add", n })}>
              +{n.toLocaleString("en-US")}
            </PgButton>
          ))}
        </div>
        <p className="muted">Changing the opening balance starts a new ledger. Click a float total to see its bits below.</p>
      </div>

      <div className="fp-cols">
        <Column st={st} col="f64" name={T.f64} dispatch={dispatch} />
        <Column st={st} col="f32" name={T.f32} dispatch={dispatch} />
        <div className="pg-side fp-col">
          <header><h4>{T.int}</h4><span className="pg-status done">exact</span></header>
          <span className="fp-total static">{formatCents(st.totals.cents)}</span>
          <dl className="pg-stats fp-stats">
            <div><dt>Drift · cents</dt><dd>0</dd></div>
            <div><dt>Last deposit, recovered</dt><dd>{st.prev ? formatCents(st.totals.cents - st.prev.cents) : "–"}</dd></div>
          </dl>
          <p className="muted fp-small">Integer adds are exact until the integer overflows: about 92 quadrillion dollars in int64 cents.</p>
        </div>
      </div>

      {st.batches.length > 0 && (
        <div className="pg-card">
          <span className="label">Drift after each batch (cents)</span>
          <div className="fp-scroll">
            <table className="fp-table">
              <thead><tr><th>Adds</th><th>Amount</th><th>{T.f64}</th><th>{T.f32}</th><th>{T.int}</th></tr></thead>
              <tbody>
                {st.batches.map((b, i) => (
                  <tr key={i}><td>{b.adds.toLocaleString("en-US")}</td><td>{amountOf(b.amount).label}</td>
                    <td className={Math.abs(b.d64) >= 1 ? "bad" : ""}>{fmtDrift(b.d64)}</td>
                    <td className={Math.abs(b.d32) >= 1 ? "bad" : ""}>{fmtDrift(b.d32)}</td><td>0</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Inspector st={st} dispatch={dispatch} />

      <div className="pg-req">
        <span className="label">Challenges: {CHALLENGES.filter((c) => st.done[c.id]).length} of {CHALLENGES.length}</span>
        <ul className="fp-list">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "got" : ""}><span aria-hidden="true">{st.done[c.id] ? "■" : "□"}</span> {c.text}</li>)}
        </ul>
      </div>

      {st.adds > 0 && <Result st={st} T={T} />}

      <PgSources links={[
        { title: "float.exposed by Bartosz Ciechanowski", href: "https://float.exposed/" },
        { title: "Exposing Floating Point", href: "https://ciechanow.ski/exposing-floating-point/" },
        { title: "0.30000000000000004.com", href: "https://0.30000000000000004.com/" },
      ]} />

      <style>{CSS}</style>
    </PgFrame>
  );
}

const CSS = `
.fp-rows { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.fp-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.fp-col.off { border-color: var(--pain); }
.fp-total { font-family: var(--f-code); font-size: 1.05rem; font-weight: 600; text-align: left; padding: 6px 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.fp-total:hover, .fp-total:focus-visible { border-color: var(--accent); outline: none; }
.fp-total.static { cursor: default; }
.fp-col.off .fp-total { color: var(--pain); }
.fp-stats { grid-template-columns: 1fr 1fr; }
.fp-small { font-size: .82rem; margin: 0; }
.fp-bar { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
.fp-form { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.fp-form input { font-family: var(--f-code); font-size: .9rem; padding: 4px 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); width: 12em; border-radius: 0; }
.fp-form input:focus-visible { outline: 2px solid var(--accent); }
.fp-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.fp-chips .pg-btn { font-family: var(--f-code); font-size: .72rem; }
.fp-err { color: var(--pain); margin: 4px 0 0; font-size: .85rem; }
.fp-bits { display: grid; gap: 2px; margin-top: 8px; padding: 6px; border: 1px solid var(--line); background: var(--surface); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 12px 12px; }
.fp-bits.w32 { grid-template-columns: repeat(32, minmax(0, 1fr)); }
.fp-bits.w64 { grid-template-columns: repeat(32, minmax(0, 1fr)); }
.fp-bit { min-width: 0; height: 26px; padding: 0; font-family: var(--f-code); font-size: .7rem; border: 1px solid var(--line); background: var(--bg); color: var(--ink-2); cursor: pointer; transition: background-color .15s var(--ease); }
.fp-bit.s { --c: var(--pain); } .fp-bit.e { --c: var(--accent); } .fp-bit.m { --c: var(--good); }
.fp-bit { border-bottom: 3px solid var(--c); }
.fp-bit.on { background: color-mix(in srgb, var(--c) 30%, var(--surface)); color: var(--ink); font-weight: 700; }
.fp-bit:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.fp-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 4px 0 0; font-family: var(--f-code); font-size: .65rem; color: var(--ink-2); text-transform: uppercase; letter-spacing: .05em; }
.fp-legend span::before { content: ""; display: inline-block; width: 14px; height: 0; margin-right: 4px; vertical-align: middle; border-top: 3px solid var(--c); }
.fp-legend .s { --c: var(--pain); } .fp-legend .e { --c: var(--accent); } .fp-legend .m { --c: var(--good); }
.fp-read { margin-top: 8px; }
.fp-formula, .fp-exact { margin: 6px 0 0; font-size: .85rem; overflow-wrap: anywhere; }
.fp-exact code { overflow-wrap: anywhere; }
.fp-scroll { overflow-x: auto; }
.fp-table { width: 100%; border-collapse: collapse; font-size: .85rem; font-variant-numeric: tabular-nums; }
.fp-table th, .fp-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
.fp-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.fp-table td.bad { color: var(--pain); font-weight: 600; }
.fp-list { list-style: none; padding-left: 0 !important; }
.fp-list li.got { color: var(--good); }
@media (max-width: 720px) { .fp-cols { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .fp-rows { grid-template-columns: 1fr; } .fp-bits.w32, .fp-bits.w64 { grid-template-columns: repeat(16, minmax(0, 1fr)); } }
@media (prefers-reduced-motion: reduce) { .fp-bit { transition: none; } }
`;
