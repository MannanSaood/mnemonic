"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, EXPONENTS, MODULI, PRIMES,
  currentKey, euclid, euclidDone, factor, gcd, invariantHolds, inverse, mod, orbit, powTrace, step, init,
  type Modulus, type State,
} from "./model";

const n0 = (x: number) => x.toLocaleString("en");

function Dial({ st, onPick, reduced }: { st: State; onPick: (a: number) => void; reduced: boolean }) {
  const m = st.m;
  const pos = (k: number, r: number) => {
    const ang = (k / m) * 2 * Math.PI - Math.PI / 2;
    return [50 + r * Math.cos(ang), 50 + r * Math.sin(ang)] as const;
  };
  const orb = orbit(st.a, m);
  const seen = new Set(orb);
  const path = [0, ...orb].map((k, i) => { const [x, y] = pos(k, 38); return `${i ? "L" : "M"}${x},${y}`; }).join(" ");
  const inv = inverse(st.a, m);
  return (
    <div className="ma-dial">
      <svg viewBox="0 0 100 100" className="ma-svg" aria-hidden="true">
        <circle cx={50} cy={50} r={38} className="ma-ring" />
        <path d={path} className={`ma-orbit${gcd(st.a, m) === 1 ? " unit" : " stuck"}${reduced ? "" : " anim"}`} key={`${m}-${st.a}`} />
      </svg>
      {Array.from({ length: m }, (_, k) => {
        const [x, y] = pos(k, 45);
        const cls = `ma-tick${k === st.a ? " sel" : ""}${seen.has(k) ? " hit" : ""}${k === 1 ? " one" : ""}${inv !== null && k === inv ? " inv" : ""}`;
        return (
          <button key={k} className={cls} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => onPick(k)} disabled={k === 0}
            aria-pressed={k === st.a} aria-label={`Step by ${k}${seen.has(k) ? ", visited" : ""}`}>{k}</button>
        );
      })}
      <span className="ma-center">mod {m}</span>
    </div>
  );
}

function Euclid({ st, dispatch }: { st: State; dispatch: (a: { type: "euclidStep" } | { type: "euclidAll" }) => void }) {
  const rows = euclid(st.a, st.m);
  const shown = rows.slice(0, st.rowsShown);
  const done = euclidDone(st);
  const g = rows[rows.length - 2];
  return (
    <div className="pg-card">
      <span className="label">Extended Euclid on ({st.m}, {st.a}) · every row keeps r ≡ s · {st.a} (mod {st.m})</span>
      <table className="ma-table">
        <thead><tr><th>q</th><th>r</th><th>s</th><th>s · {st.a} mod {st.m}</th><th>Holds</th></tr></thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className={i === shown.length - 1 ? "cur" : ""}>
              <td>{r.q ?? "-"}</td><td>{r.r}</td><td>{r.s}</td><td>{mod(r.s * st.a, st.m)}</td>
              <td className={invariantHolds(r, st.a, st.m) ? "ma-ok" : "ma-no"}>{invariantHolds(r, st.a, st.m) ? "✓" : "✗"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pg-actions">
        <PgButton primary onClick={() => dispatch({ type: "euclidStep" })} disabled={done}>Next row</PgButton>
        <PgButton onClick={() => dispatch({ type: "euclidAll" })} disabled={done}>All rows</PgButton>
      </div>
      <p className="muted" aria-live="polite">
        {!done ? "Each row: q = previous r ÷ this r, then r and s both subtract q times this row. The remainder shrinks fast."
          : g.r === 1 ? `r reached 1 with s = ${g.s}, so ${g.s} · ${st.a} ≡ 1 (mod ${st.m}). The inverse is ${mod(g.s, st.m)}. ${rows.length - 2} division steps.`
          : `The last non-zero r is ${g.r} = gcd(${st.a}, ${st.m}). Every row is a multiple of ${g.r}, so 1 is never reached: ${st.a} has no inverse mod ${st.m}.`}
      </p>
    </div>
  );
}

function Rsa({ st, dispatch }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  const k = currentKey(st);
  const last = st.sent[st.sent.length - 1];
  const trace = last && !st.naive ? powTrace(last.msg, k.e, k.n) : [];
  const repeats = last ? st.sent.filter((x) => x.msg === last.msg).length : 0;
  const primeOpts = PRIMES.map((p) => ({ value: String(p), label: String(p) }));
  return (
    <div className="pg-card ma-rsa">
      <span className="label">Toy RSA · two small primes, one public exponent</span>
      <p className="ma-warn"><b>Toy only.</b> Real RSA uses primes of 1,024 bits or more and random padding (OAEP for encryption, PSS for signatures), from a vetted library. A key this small falls to the attack button below in microseconds.</p>
      <div className="ma-rows">
        <span className="pg-place">p</span>
        <PgChoice<string> label="Prime p" value={String(st.p)} onChange={(v) => dispatch({ type: "p", p: Number(v) })} options={primeOpts} />
        <span className="pg-place">q</span>
        <PgChoice<string> label="Prime q" value={String(st.q)} onChange={(v) => dispatch({ type: "q", q: Number(v) })} options={primeOpts} />
        <span className="pg-place">e</span>
        <PgChoice<string> label="Public exponent e" value={String(st.e)} onChange={(v) => dispatch({ type: "e", e: Number(v) })}
          options={EXPONENTS.map((e) => ({ value: String(e), label: String(e) }))} />
      </div>
      <dl className="pg-stats ma-stats">
        <div><dt>n = p · q</dt><dd>{n0(k.n)}</dd></div>
        <div><dt>φ = (p−1)(q−1)</dt><dd>{n0(k.phi)}</dd></div>
        <div className={k.d === null ? "bad" : ""}><dt>d = e⁻¹ mod φ</dt><dd>{k.p === k.q ? "p = q" : k.d === null ? `none: gcd ${gcd(k.e, k.phi)}` : n0(k.d)}</dd></div>
      </dl>
      {k.d !== null && <p className="muted">Check: e · d = {n0(k.e * k.d)} = {Math.floor((k.e * k.d) / k.phi)} · φ + 1. Public key (n, e) = ({n0(k.n)}, {k.e}); private d = {n0(k.d)}.</p>}
      <div className="ma-msg">
        <label htmlFor="ma-msg">Message m (below n)</label>
        <input id="ma-msg" type="number" min={0} max={k.n - 1} value={st.msg} onChange={(ev) => dispatch({ type: "msg", msg: Number(ev.target.value) })} />
        <PgButton primary onClick={() => dispatch({ type: "encrypt" })}>Encrypt: c = m^e mod n</PgButton>
        <PgButton onClick={() => dispatch({ type: "decrypt" })} disabled={!last || k.d === null}>Decrypt: c^d mod n</PgButton>
      </div>
      <label className="ma-break">
        <input type="checkbox" checked={st.naive} onChange={() => dispatch({ type: "naive" })} />
        Break it: compute m ** e in floating point, then take % n once
      </label>
      {last && (
        <div className="ma-out" aria-live="polite">
          <p>m = {last.msg} → c = <b>{Number.isNaN(last.c) ? "NaN" : n0(last.c)}</b>{st.decrypted !== null && <> → back to <b className={st.decrypted === last.msg ? "ma-ok" : "ma-no"}>{Number.isNaN(st.decrypted) ? "NaN" : n0(st.decrypted)}</b></>}
            {repeats > 1 && <> · encrypted {repeats} times, same c every time</>}</p>
          {st.naive && <p className="ma-no">{last.msg}^{k.e} has about {Math.round(k.e * Math.log10(Math.max(2, last.msg)))} digits; a double keeps about 16, so the remainder is noise{st.decrypted !== null ? ", and c^d overflows to Infinity, whose remainder is NaN" : ""}.</p>}
          {trace.length > 0 && (
            <ol className="ma-trace" aria-label="Square and multiply">
              {trace.map((t, i) => <li key={i}><span>bit {t.bit}</span> square → {t.squared}{t.bit ? ` × ${last.msg} → ${t.result}` : ""}</li>)}
            </ol>
          )}
          {trace.length > 0 && <p className="muted">{trace.length} squarings for e = {k.e} ({k.e.toString(2)} in binary), each reduced mod n, so no number ever exceeds n². For a 2048-bit d that is about 2,048 squarings.</p>}
        </div>
      )}
      <div className="pg-actions">
        <PgButton onClick={() => dispatch({ type: "attack" })} disabled={!last || Number.isNaN(last.c)}>Attack: read c with only (n, e)</PgButton>
      </div>
      {st.attack && (
        <p className="ma-no" aria-live="polite">Found m = {st.attack.msg} after encrypting {n0(st.attack.tries)} guesses, because textbook RSA encrypts the same message to the same c. Trial division also factors n = {n0(k.n)} in {st.attack.divisions} divisions (p = {factor(k.n).p}), which gives φ and then d. A 2048-bit n has 617 digits; no known method factors it.</p>
      )}
    </div>
  );
}

function Result({ st }: { st: State }) {
  const g = gcd(st.a, st.m), inv = inverse(st.a, st.m), k = currentKey(st), last = st.sent[st.sent.length - 1];
  const clock = inv !== null
    ? `On your ${st.m}-tick clock, stepping by ${st.a} visits all ${st.m} ticks and lands on 1 after ${inv} steps, so ${inv} is its inverse: × ${st.a} can be undone by × ${inv}.`
    : `On your ${st.m}-tick clock, stepping by ${st.a} visits only ${st.m / g} of ${st.m} ticks, because gcd(${st.a}, ${st.m}) = ${g}. Inputs collide, 1 is never reached, and × ${st.a} cannot be undone.`;
  const rsa = k.d === null ? `Your RSA key has no d: e = ${k.e} shares a factor with φ = ${k.phi}, the same failure one level up.`
    : last ? `Your key (n ${n0(k.n)}, e ${k.e}, d ${n0(k.d)}) sent ${last.msg} as ${Number.isNaN(last.c) ? "NaN" : last.c}${st.attack ? `, and the attacker read it after ${n0(st.attack.tries)} guesses` : ""}.`
    : `Your key has d = ${n0(k.d)}, the inverse of e modulo φ, found by the same Euclid table.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What you found</span>
      <p>{clock} {rsa}</p>
      <p className="pg-takeaway">Division modulo m exists only for numbers that share no factor with m, and the extended Euclidean algorithm finds it. RSA works because d is such an inverse for e modulo φ(n); it is safe only with huge n and random padding.</p>
    </div>
  );
}

export default function ModularPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const g = gcd(st.a, st.m);
  const inv = inverse(st.a, st.m);
  const visited = orbit(st.a, st.m).length;

  return (
    <PgFrame title="Clock arithmetic, inverses and toy RSA" onReset={() => dispatch({ type: "reset" })}>
      <PgPredict
        question="On a 12-tick clock, start at 0 and keep adding 8: 8, 4, … How many different ticks do you land on? Click 8 on the dial to check."
        options={[{ value: "12", label: "All 12" }, { value: "6", label: "6" }, { value: "3", label: "3" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.sawEight}
        answer="3"
        explain={<>8, 4, 0, then it repeats. 8 and 12 share the factor 4, so every multiple of 8 is a multiple of 4: only 12 / 4 = 3 ticks are reachable. 1 is not one of them, so nothing times 8 gives 1 and 8 has no inverse mod 12. A hash table of 12 slots probed with stride 8 would only ever look in 3 of them.</>}
      />

      <div className="pg-grid ma-two">
        <div className="pg-card">
          <span className="label">Clock · click a tick to step by it</span>
          <PgChoice<string> label="Ticks on the clock" value={String(st.m)} onChange={(v) => dispatch({ type: "m", m: Number(v) as Modulus })}
            options={MODULI.map((m) => ({ value: String(m), label: `mod ${m}` }))} />
          <Dial st={st} onPick={(a) => dispatch({ type: "a", a })} reduced={reduced} />
          <dl className="pg-stats ma-stats">
            <div><dt>gcd({st.a}, {st.m})</dt><dd>{g}</dd></div>
            <div className={visited < st.m ? "bad" : ""}><dt>Ticks visited</dt><dd>{visited} of {st.m}</dd></div>
            <div className={inv === null ? "bad" : ""}><dt>{st.a}⁻¹ mod {st.m}</dt><dd>{inv ?? "none"}</dd></div>
          </dl>
          <p className="muted">{inv !== null ? `${st.a} × ${inv} = ${st.a * inv} = ${Math.floor((st.a * inv) / st.m)} · ${st.m} + 1. As a hash probe with stride ${st.a}, every one of ${st.m} slots gets checked.` : `As a hash probe with stride ${st.a}, only ${visited} of ${st.m} slots are ever checked, and a full-looking table can still have free slots.`}</p>
        </div>
        <Euclid st={st} dispatch={dispatch} />
      </div>

      <Rsa st={st} dispatch={dispatch} />

      <div className="pg-req">
        <span className="label">Challenges: {CHALLENGES.filter((c) => st.done[c.id]).length} of {CHALLENGES.length}</span>
        <ul className="ma-list">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "got" : ""}><span aria-hidden="true">{st.done[c.id] ? "■" : "□"}</span> {c.text}</li>)}
        </ul>
      </div>

      {(st.sawEight || st.sent.length > 0) && <Result st={st} />}

      <PgSources links={[
        { title: "Brian Seib's modclock", href: "https://bseib.github.io/modclock" },
        { title: "RSAvisual (Michigan Tech)", href: "https://www.cs.mtu.edu/~shene/NSF-4/RSA-Downloads/index.html" },
        { title: "the University of Rhode Island extended Euclid demo", href: "https://www.cs.uri.edu/cryptography/number-theory/extended-euclids-algorithm/demo.html" },
      ]} />

      <style>{CSS}</style>
    </PgFrame>
  );
}

const CSS = `
.ma-two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.ma-dial { position: relative; width: 100%; max-width: 300px; aspect-ratio: 1; justify-self: center; margin: 4px auto; }
.ma-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.ma-ring { fill: none; stroke: var(--line); stroke-width: .6; }
.ma-orbit { fill: color-mix(in srgb, var(--accent) 8%, transparent); stroke: var(--accent); stroke-width: .9; stroke-linejoin: round; }
.ma-orbit.stuck { stroke: var(--pain); fill: color-mix(in srgb, var(--pain) 10%, transparent); }
.ma-orbit.anim { stroke-dasharray: 600; animation: ma-draw .9s var(--ease); }
@keyframes ma-draw { from { stroke-dashoffset: 600; } to { stroke-dashoffset: 0; } }
.ma-tick { position: absolute; transform: translate(-50%, -50%); width: 2.1em; height: 2.1em; padding: 0; display: grid; place-items: center;
  font-family: var(--f-code); font-size: .74rem; border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); cursor: pointer; }
.ma-tick.hit { color: var(--ink); border-color: var(--accent); }
.ma-tick.one { font-weight: 700; }
.ma-tick.inv { box-shadow: inset 0 -3px 0 var(--good); }
.ma-tick.sel { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.ma-tick:disabled { cursor: default; opacity: .7; }
.ma-center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-family: var(--f-code); font-size: .7rem; text-transform: uppercase; color: var(--ink-2); }
.ma-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ma-table { width: 100%; border-collapse: collapse; font-family: var(--f-code); font-size: .8rem; font-variant-numeric: tabular-nums; }
.ma-table th, .ma-table td { border-bottom: 1px solid var(--line); padding: 3px 6px; text-align: right; }
.ma-table th { font-weight: 400; color: var(--ink-2); font-size: .66rem; text-transform: uppercase; }
.ma-table tr.cur td { background: var(--hl); }
.ma-ok { color: var(--good); font-weight: 700; } .ma-no { color: var(--pain); }
.ma-warn { margin: 0; padding: 6px 8px; border-left: 3px solid var(--pain); background: var(--pain-bg); font-size: .9rem; }
.ma-rows { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.ma-rows .pg-choice { flex-wrap: wrap; }
.ma-msg { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ma-msg label { font-family: var(--f-code); font-size: .7rem; text-transform: uppercase; color: var(--ink-2); }
.ma-msg input { width: 7em; font-family: var(--f-code); padding: 4px 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 0; }
.ma-break { display: flex; gap: 6px; align-items: center; font-size: .9rem; color: var(--pain); }
.ma-out p { margin: 0 0 4px; }
.ma-trace { margin: 0; padding-left: 1.4em; font-family: var(--f-code); font-size: .78rem; display: grid; gap: 2px; }
.ma-trace span { color: var(--ink-2); display: inline-block; min-width: 3.6em; }
.ma-list { list-style: none; padding-left: 0 !important; }
.ma-list li.got { color: var(--good); }
@media (max-width: 700px) { .ma-two { grid-template-columns: 1fr; } }
@media (max-width: 420px) { .ma-tick { width: 1.8em; height: 1.8em; font-size: .64rem; } .ma-rows { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .ma-orbit.anim { animation: none; } }
`;
