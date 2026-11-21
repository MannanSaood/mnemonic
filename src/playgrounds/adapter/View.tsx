"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CALLS, CHECK_DECISION, DECISIONS, WORK, init, money, step,
  type Adapter, type Decision, type Guess, type Metrics, type Outcome, type State,
} from "./model";

const CSS = `
.adapter-board { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.5fr) minmax(0, .8fr); gap: 8px; align-items: stretch; }
.adapter-board > section { border: 1px solid var(--line); background: var(--bg); padding: 8px 10px; display: grid; gap: 6px; align-content: start; min-width: 0; }
.adapter-board > section.adapter-mid { border-color: var(--accent); border-width: 2px; }
.adapter-board code { font-size: .66rem; white-space: pre-wrap; word-break: break-word; }
.adapter-fixed { font-family: var(--f-code); font-size: .6rem; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); }
.adapter-dec { border-top: 1px solid var(--line); padding-top: 6px; display: grid; gap: 4px; }
.adapter-dec header { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
.adapter-work { font-family: var(--f-code); font-size: .6rem; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
.adapter-dec .pgc-line { padding: 2px 6px; min-height: 0; }
.adapter-calls { display: grid; gap: 6px; }
.adapter-calls .pg-entry p { font-size: .9rem; }
.adapter-path span.bad { border-color: var(--pain); color: var(--pain); font-weight: 600; }
.adapter-checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: .85rem; }
.adapter-checks li::before { content: "✗ "; color: var(--pain); font-weight: 700; }
.adapter-checks li.ok::before { content: "✓ "; color: var(--good); }
.adapter-checks .adapter-work { margin-left: 6px; }
.adapter-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 0; }
.adapter-stats div { background: var(--surface); padding: 6px 8px; display: grid; gap: 2px; }
.adapter-stats dt { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.adapter-stats dd { margin: 0; font-family: var(--f-code); font-size: .85rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.adapter-stats div.bad dd { color: var(--pain); }
@media (max-width: 760px) { .adapter-board { grid-template-columns: 1fr; } }
`;

/* ---------------- the adapter's code, per language and per choice ---------------- */

type Lines = Record<Decision, Record<string, string>>;
const CODE: Record<Lang, Lines> = {
  go: {
    amount: { fixed2: 'Amount: fmt.Sprintf("%.2f", float64(amount)/100),', exponent: "Amount: majorUnits(amount, currency), // ISO 4217: JPY 0, KWD 3" },
    status: { okOrError: 'if res.ResultCode != "00" { return Receipt{}, ErrGateway }', mapped: 'case "05", "51": return Receipt{ID: res.TxnRef, Status: Declined}, nil' },
    errors: { raw: "return Receipt{}, err // *acme.TimeoutError, as is", wrapped: "return Receipt{}, &GatewayError{Retryable: acme.IsTimeout(err), Err: err}" },
    retry: { none: "// Acme has no idempotency keys", lookup: "if prev, ok := a.client.FindByRef(ref); ok { return toReceipt(prev), nil }" },
  },
  python: {
    amount: { fixed2: 'amount=f"{amount / 100:.2f}",', exponent: "amount=major_units(amount, currency),  # ISO 4217: JPY 0, KWD 3" },
    status: { okOrError: 'if res.result_code != "00": raise GatewayError(res.result_code)', mapped: 'if res.result_code in ("05", "51"): return Receipt(res.txn_ref, Status.DECLINED)' },
    errors: { raw: "# acme.Timeout propagates as is", wrapped: "except acme.Timeout as e: raise GatewayError(retryable=True) from e" },
    retry: { none: "# Acme has no idempotency keys", lookup: "if (prev := self.client.find_by_ref(ref)) is not None: return to_receipt(prev)" },
  },
  typescript: {
    amount: { fixed2: "amount: (amount / 100).toFixed(2),", exponent: "amount: majorUnits(amount, currency), // ISO 4217: JPY 0, KWD 3" },
    status: { okOrError: 'if (res.resultCode !== "00") throw new GatewayError(res.resultCode);', mapped: 'if (res.resultCode === "05" || res.resultCode === "51") return { id: res.txnRef, status: "declined" };' },
    errors: { raw: "// AcmeTimeoutError is rethrown as is", wrapped: "catch (e) { throw new GatewayError(\"acme\", { retryable: e instanceof AcmeTimeoutError, cause: e }); }" },
    retry: { none: "// Acme has no idempotency keys", lookup: "const prev = await this.client.findByRef(ref); if (prev) return toReceipt(prev);" },
  },
  rust: {
    amount: { fixed2: 'amount: format!("{:.2}", amount as f64 / 100.0),', exponent: "amount: major_units(amount, currency), // ISO 4217: JPY 0, KWD 3" },
    status: { okOrError: 'if res.result_code != "00" { return Err(GatewayError::Other) }', mapped: '"05" | "51" => Ok(Receipt::declined(res.txn_ref)),' },
    errors: { raw: "let res = self.make_payment(req)?; // acme::Error, as is", wrapped: ".map_err(|e| GatewayError::from_acme(e))?; // timeouts are retryable" },
    retry: { none: "// Acme has no idempotency keys", lookup: "if let Some(prev) = self.find_by_ref(reference)? { return Ok(prev.into()) }" },
  },
};

const OPTIONS: Record<Decision, { value: string; label: string }[]> = {
  amount: [{ value: "fixed2", label: "cents ÷ 100" }, { value: "exponent", label: "by minor unit" }],
  status: [{ value: "okOrError", label: '"00" or error' }, { value: "mapped", label: "map 05, 51" }],
  errors: [{ value: "raw", label: "let through" }, { value: "wrapped", label: "GatewayError" }],
  retry: [{ value: "none", label: "charge again" }, { value: "lookup", label: "find_by_ref first" }],
};

function AdapterFile({ a, lang, onSet }: { a: Adapter; lang: Lang; onSet: (d: Decision, v: string) => void }) {
  return (
    <section className="adapter-mid" aria-label="The adapter">
      <span className="label">AcmeAdapter · the only file that knows Acme</span>
      {DECISIONS.map((d) => {
        const naive = OPTIONS[d][0].value === a[d];
        return (
          <div key={d} className="adapter-dec">
            <header>
              <span className="adapter-work">{WORK[d]}</span>
              <PgChoice label={WORK[d]} value={a[d]} options={OPTIONS[d]} onChange={(v) => onSet(d, v)} />
            </header>
            <div className={"pgc-line" + (naive ? "" : " new")}><code>{CODE[lang][d][a[d]]}</code></div>
          </div>
        );
      })}
    </section>
  );
}

function CallRow({ o }: { o: Outcome }) {
  const ok = o.checks.every((c) => c.ok);
  return (
    <div className={"pg-entry" + (ok ? " ok" : " fail")}>
      <div className="pg-path adapter-path" aria-hidden="true">
        {o.hops.map((h, i) => <span key={i} className={h.bad ? "bad" : ""}>{h.text}</span>)}
      </div>
      <p><b>{o.call.label}.</b> Charged {o.chargeCount === 0 ? "nothing" : o.chargeCount === 1 ? money(o.charged, o.call.currency) : `${money(o.charged / o.chargeCount, o.call.currency)} twice`}. Customer saw: {o.customerSaw}</p>
      <ul className="adapter-checks">
        {o.checks.map((c) => (
          <li key={c.id} className={c.ok ? "ok" : ""}>{c.text}{!c.ok && <span className="adapter-work">fix: {WORK[CHECK_DECISION[c.id]]}</span>}</li>
        ))}
      </ul>
    </div>
  );
}

function Stats({ m }: { m: Metrics }) {
  return (
    <dl className="adapter-stats">
      <div className={m.checksPassed < m.checksTotal ? "bad" : ""}><dt>Contract checks</dt><dd>{m.checksPassed} of {m.checksTotal}</dd></div>
      <div className={m.wrongAmounts ? "bad" : ""}><dt>Wrong amounts</dt><dd>{m.wrongAmounts}</dd></div>
      <div className={m.doubleCharges ? "bad" : ""}><dt>Double charges</dt><dd>{m.doubleCharges}</dd></div>
      <div className={m.errors500 ? "bad" : ""}><dt>HTTP 500s</dt><dd>{m.errors500}</dd></div>
      <div className={m.misleading ? "bad" : ""}><dt>Wrong messages</dt><dd>{m.misleading}</dd></div>
    </dl>
  );
}

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Result({ st }: { st: State }) {
  const f = st.first!.metrics, m = st.run!.metrics;
  if (m.checksPassed < m.checksTotal) return null;
  const k = st.fixes.length;
  const jpy = st.first!.outcomes.find((o) => o.call.currency === "JPY")!, kwd = st.first!.outcomes.find((o) => o.call.currency === "KWD")!;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p><b>The first adapter</b> passed {f.checksPassed} of {f.checksTotal} checks: it charged {money(jpy.charged, "JPY")} for a {money(jpy.call.amount, "JPY")} order, {money(kwd.charged, "KWD")} for a {money(kwd.call.amount, "KWD")} renewal, and €99.00 twice after a timeout.</p>
      <p><b>Yours</b> passes {m.checksPassed} of {m.checksTotal} after {n(k, "fix", "fixes")}, all in one file. Checkout and renewals: {st.callerEdits} edits.</p>
      <p className="pg-takeaway">Without the adapter, checkout and renewals would each carry these {n(k, "translation")}: {2 * k} edits instead of {k}, and the renewals copy is the one that gets forgotten. An adapter is where the translation lives. It is rarely just renaming: here it converted units, mapped codes and errors, and added idempotency that Acme does not have.</p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "right", label: "¥1,250" },
  { value: "under", label: "¥12" },
  { value: "rejected", label: "Acme rejects it" },
];

export default function AdapterPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch } = useModel(step, init);
  return (
    <PgFrame title="Build the adapter, run the contract suite" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        Our code charges through <code>gateway.charge(amount, currency, ref)</code>, with amounts in minor units (cents).
        The Gulf acquirer, Acme, has a legacy SDK with its own idea of everything. <b>Make the adapter pass all six
        contract checks without touching checkout, renewals or Acme.</b>
      </p>

      <PgPredict<Guess>
        question="The first adapter follows Acme's docs, whose example is in euros: amount = cents ÷ 100, two decimals. Acme reads that in major units and drops digits a currency does not have. What does the customer with the ¥1,250 order pay?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={!!st.run}
        answer="under"
        explain='Yen has no minor unit, so 1250 already means ¥1,250. Dividing by 100 sends "12.50", and Acme charges ¥12. The same rule sends KWD 125.00 for a KWD 12.500 renewal, because dinars have three decimals: ten times too much.'
      />

      <div className="adapter-board">
        <section aria-label="Our code">
          <span className="label">Our code</span>
          <span className="adapter-fixed">Never edited · edits: {st.callerEdits}</span>
          <div className="pgc"><div className="pgc-line"><code>checkout: gateway.charge(order.total, order.currency, order.id)</code></div>
            <div className="pgc-line"><code>renewals: gateway.charge(sub.price, sub.currency, invoice.id)</code></div></div>
          <p className="pg-note">Retries a retryable GatewayError once, with the same ref. Any other exception becomes an HTTP 500.</p>
        </section>
        <AdapterFile a={st.adapter} lang={lang} onSet={(d, v) => dispatch({ type: "set", decision: d, value: v })} />
        <section aria-label="The Acme SDK">
          <span className="label">Acme SDK</span>
          <span className="adapter-fixed">Vendor code · cannot change</span>
          <div className="pgc">
            <div className="pgc-line"><code>make_payment(amount: str, curr)</code></div>
            <div className="pgc-line"><code>amount in major units</code></div>
            <div className="pgc-line"><code>result_code: 00 ok · 05 do not honour · 51 no funds</code></div>
            <div className="pgc-line"><code>raises AcmeTimeout</code></div>
            <div className="pgc-line"><code>find_by_ref(merchant_ref)</code></div>
          </div>
          <p className="pg-note">No idempotency keys. A second call charges again.</p>
        </section>
      </div>

      {st.run ? (
        <>
          <span className="label">Contract suite: {CALLS.length} payments, our call → Acme → back</span>
          <div className="adapter-calls" aria-live="polite">
            {st.run.outcomes.map((o) => <CallRow key={o.call.id} o={o} />)}
          </div>
          <Stats m={st.run.metrics} />
          <Result st={st} />
        </>
      ) : (
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "run" })}>Run {CALLS.length} payments through the adapter</PgButton>
          <span className="muted">After the first run, every change to the adapter reruns the suite.</span>
        </div>
      )}

      <PgSources links={[
        { title: "Refactoring.Guru's Adapter (its units-conversion example)", href: "https://refactoring.guru/design-patterns/adapter" },
        { title: "Stripe's notes on zero- and three-decimal currencies", href: "https://docs.stripe.com/currencies" },
        { title: "Stripe's idempotent requests", href: "https://docs.stripe.com/api/idempotent_requests" },
      ]} />
    </PgFrame>
  );
}
